'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');
const svgCaptcha = require('svg-captcha');
const sharp = require('sharp');
const repo = require('../../db/repo');
const { hasElevatedPermissions } = require('../../utils/helpers');
const logger = require('../../utils/logger');

// Sistema di verifica al join: gli utenti non ancora "verificati" non possono
// creare/vedere i canali vocali temporanei (vedi events/voiceStateUpdate e
// services/verify-gate). Il captcha è effimero e casuale: due modalità scelte
// a caso per ogni tentativo:
//   - numero: l'utente deve cliccare il numero corretto tra 1 e 15
//   - emoji:  l'utente deve cliccare l'emoji corretta tra 15 proposte
// Il captcha non lascia tracce nel canale (ephemeral), e solo l'utente può
// interagire con i bottoni (customId contiene un challengeId opaco + userId).
//
// Bypass per staff con permessi elevati: chi ha Administrator/Ban/Kick/Moderate
// Members viene considerato verificato implicitamente (utile per i test e per
// non costringere i moderatori a fare il captcha).

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const challenges = new Map();

// Pool di emoji "sicure": evitiamo bandiere, simboli rari, combinatori.
// 15 emoji ordinate per una griglia 5×3 leggibile.
const EMOJI_POOL = [
  '🍎', '🍌', '🍇', '🍉', '🍒',
  '🥑', '🥕', '🌽', '🍕', '🍔',
  '⚽', '🏀', '🎮', '🎲', '🎯',
];

function makeChallengeId() {
  // 16 caratteri hex sono sufficienti: anti-brute-force a livello di bottoni.
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
}

function gcChallenges(now) {
  for (const [id, ch] of challenges) {
    if (ch.expiresAt <= now) challenges.delete(id);
  }
}

function buildNumberChallenge() {
  const correct = 1 + Math.floor(Math.random() * 15);
  // 15 bottoni, 5 per riga. Mescoliamo per non rendere ovvio l'ordine.
  const buttons = [];
  for (let i = 1; i <= 15; i++) buttons.push(i);
  for (let i = buttons.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [buttons[i], buttons[j]] = [buttons[j], buttons[i]];
  }

  const rows = [];
  for (let i = 0; i < 15; i += 5) {
    const row = new ActionRowBuilder();
    for (let j = i; j < i + 5; j++) {
      const n = buttons[j];
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`verify:captcha:placeholder:${n}:0`)
          .setLabel(String(n))
          .setStyle(ButtonStyle.Secondary),
      );
    }
    rows.push(row);
  }
  return { kind: 'num', correct, rows };
}

function buildEmojiChallenge() {
  const correctIdx = Math.floor(Math.random() * EMOJI_POOL.length);
  const correctEmoji = EMOJI_POOL[correctIdx];
  // Shuffle indici per la griglia
  const indices = EMOJI_POOL.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const rows = [];
  for (let i = 0; i < 15; i += 5) {
    const row = new ActionRowBuilder();
    for (let j = i; j < i + 5; j++) {
      const poolIdx = indices[j];
      const emoji = EMOJI_POOL[poolIdx];
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`verify:captcha:placeholder:${poolIdx}:0`)
          .setEmoji(emoji)
          .setStyle(ButtonStyle.Secondary),
      );
    }
    rows.push(row);
  }
  return { kind: 'emo', correct: correctIdx, correctEmoji, rows };
}

function buildImageChallenge() {
  // 4-6 caratteri alfanumerici, ignorando 0/O/1/l/I per evitare ambiguità.
  const size = 4 + Math.floor(Math.random() * 3);
  const { data, text } = svgCaptcha.create({
    size,
    ignoreChars: '0o1ilI',
    noise: 3,
    color: false,
    background: '#f0f0f0',
  });
  // Discord a volte mostra gli allegati SVG come file di testo. Convertiamo
  // in PNG via sharp: output universalmente renderizzato come immagine.
  // NB: buildImageChallenge è sincrono, ma la conversione è async: la
  // facciamo a parte in runChallenge passando la promise.
  const pngPromise = sharp(Buffer.from(data, 'utf8')).png().toBuffer();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('verify:btn:img-input:placeholder')
      .setLabel('Inserisci risposta')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Secondary),
  );
  return { kind: 'img', correct: text.toLowerCase(), rows: [row], pngPromise, size };
}

const data = new SlashCommandBuilder()
  .setName('verify')
  .setDescription('Avvia la verifica per ottenere il ruolo verificato');

// /verify-test: stesso flusso di /verify ma pensato per testare captcha e UI
// senza i guardrail di produzione (già verificato / staff bypass). Non skippia
// nessun check di captcha: prova davvero la logica di validazione.
const testData = new SlashCommandBuilder()
  .setName('verify-test')
  .setDescription('Testa il flusso captcha di /verify (non salta i check)');

async function execute(interaction) {
  return runChallenge(interaction, { skipAlreadyVerified: false, skipStaffBypass: false });
}

async function executeTest(interaction) {
  return runChallenge(interaction, { skipAlreadyVerified: true, skipStaffBypass: true });
}

async function runChallenge(interaction, { skipAlreadyVerified, skipStaffBypass }) {
  // Deferiamo subito: Discord ha un timeout hard di 3s sul primo reply.
  // Senza defer, se sharp o una query lenta sforano, l'utente vede
  // "L'applicazione non ha risposto" anche se il bot sta lavorando.
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    logger.warn({ err: err.message }, 'verify: deferReply fallito');
    return;
  }
  const cfg = await repo.getGuildConfig(interaction.guildId);
  const roleId = cfg.verified_role_id;
  if (!roleId) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Verifica non configurata').setDescription('Il ruolo verificato non è stato impostato. Chiedi a uno staff di configurarlo con `/settings verify role`.').setTimestamp()],
    });
  }

  const member = interaction.member;
  if (!skipAlreadyVerified && member?.roles?.cache?.has(roleId)) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('Sei già verificato').setDescription(`Hai già il ruolo <@&${roleId}>.`).setTimestamp()],
    });
  }

  if (!skipStaffBypass && hasElevatedPermissions(member)) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('Verifica automatica').setDescription('Hai permessi elevati, sei considerato verificato.').setTimestamp()],
    });
  }

  // Modalità random: numero, emoji o immagine (3 captcha alternativi)
  const mode = Math.random();
  const ch = mode < 1 / 3
    ? buildNumberChallenge()
    : mode < 2 / 3
      ? buildEmojiChallenge()
      : buildImageChallenge();

  // La conversione sharp SVG→PNG può richiedere alcuni secondi su container
  // piccoli. Se è la modalità immagine, deferReply per evitare il timeout
  // di Discord (3s) prima ancora che sharp finisca.
  if (ch.kind === 'img') {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (_) {}
  }

  const challengeId = makeChallengeId();
  const now = Date.now();
  gcChallenges(now);
  challenges.set(challengeId, {
    correct: ch.correct,
    kind: ch.kind,
    userId: interaction.user.id,
    guildId: interaction.guildId,
    roleId,
    expiresAt: now + CHALLENGE_TTL_MS,
  });

  // Sostituisco i customId placeholder (verify:captcha:placeholder:<n>:0) con
  // quelli reali che portano il challengeId, così il dispatcher può validare
  // la risposta senza leakare "correct" nel DOM del client.
  // Per la modalità immagine il customId del bottone è verify:btn:img-input:<id>.
  for (const row of ch.rows) {
    for (const btn of row.components) {
      const cur = btn.data.custom_id;
      if (!cur) continue;
      if (cur.startsWith('verify:captcha:placeholder:')) {
        btn.setCustomId(cur.replace('verify:captcha:placeholder:', `verify:captcha:${challengeId}:`));
      } else if (cur.startsWith('verify:btn:img-input:placeholder')) {
        btn.setCustomId(cur.replace('verify:btn:img-input:placeholder', `verify:btn:img-input:${challengeId}`));
      }
    }
  }

  const prompt = ch.kind === 'num'
    ? `Clicca il numero **${ch.correct}**. Hai 2 minuti.`
    : ch.kind === 'emo'
      ? `Clicca l'emoji **${ch.correctEmoji}**. Hai 2 minuti.`
      : `Trascrivi le lettere dell'immagine (${ch.size} caratteri). Hai 2 minuti.`;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🔐 Verifica' + (skipAlreadyVerified ? ' (test)' : ''))
    .setDescription(prompt)
    .setFooter({ text: 'Captcha effimero: solo tu puoi vedere questo messaggio.' })
    .setTimestamp();

  const payload = { embeds: [embed], components: ch.rows, flags: MessageFlags.Ephemeral };
  if (ch.kind === 'img') {
    try {
      const png = await ch.pngPromise;
      payload.files = [{ attachment: png, name: 'captcha.png' }];
    } catch (err) {
      logger.warn({ err: err.message }, 'sharp SVG->PNG fallito');
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Errore captcha').setDescription('Impossibile generare l\'immagine. Riprova con `/verify`.')],
      });
    }
  }

  await interaction.editReply(payload);
}

async function handleComponent(interaction) {
  if (!interaction.isButton()) return false;
  // customId: verify:captcha:<challengeId>:<picked>:<placeholder>
  // oppure:  verify:btn:start (bottone "Verifica" nell'embed pubblico)
  // oppure:  verify:btn:img-input:<challengeId> (bottone "Inserisci risposta" per captcha immagine)
  const parts = interaction.customId.split(':');
  if (parts.length < 3 || parts[0] !== 'verify') return false;

  // Bottone "Verifica" nell'embed pubblico: apri captcha come /verify.
  if (parts[1] === 'btn' && parts[2] === 'start') {
    return runChallenge(interaction, { skipAlreadyVerified: false, skipStaffBypass: false });
  }

  // Bottone "Inserisci risposta" per captcha immagine: apri modal.
  if (parts[1] === 'btn' && parts[2] === 'img-input') {
    const challengeId = parts[3];
    const ch = challenges.get(challengeId);
    gcChallenges(Date.now());
    if (!ch) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Captcha scaduto').setDescription('Riprova con `/verify`.')],
        flags: MessageFlags.Ephemeral,
      });
    }
    if (ch.userId !== interaction.user.id) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Non tuo').setDescription('Questo captcha non è tuo.')],
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.showModal(buildImageAnswerModal(challengeId));
  }

  if (parts[1] !== 'captcha' || parts.length < 5) return false;
  const challengeId = parts[2];
  const picked = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(picked)) return false;

  const ch = challenges.get(challengeId);
  gcChallenges(Date.now());

  if (!ch) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Captcha scaduto').setDescription('Riprova con `/verify`.')],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (ch.userId !== interaction.user.id) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Non tuo').setDescription('Questo captcha non è tuo.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (picked !== ch.correct) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('❌ Sbagliato').setDescription('Riprova con `/verify` per ottenere un nuovo captcha.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  // Corretto: assegna ruolo e ripulisci
  challenges.delete(challengeId);
  try {
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) throw new Error('membro non trovato');
    if (!member.roles.cache.has(ch.roleId)) {
      await member.roles.add(ch.roleId, 'verifica completata');
    }
  } catch (err) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Errore').setDescription(`Non ho potuto assegnare il ruolo: ${err.message}. Riprova o contatta uno staff.`)],
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('✅ Verificato').setDescription(`<@&${ch.roleId}> assegnato. Benvenuto!`)],
    flags: MessageFlags.Ephemeral,
  });
}

// --- Modal handler per captcha immagine ----------------------------------

function buildImageAnswerModal(challengeId) {
  const input = new TextInputBuilder()
    .setCustomId('risposta')
    .setLabel('Trascrivi le lettere che vedi')
    .setStyle(TextInputStyle.Short)
    .setMinLength(3)
    .setMaxLength(10)
    .setRequired(true);
  const row = new ActionRowBuilder().addComponents(input);
  return new ModalBuilder()
    .setCustomId(`verify:modal:img:${challengeId}`)
    .setTitle('Verifica captcha')
    .addComponents(row);
}

async function handleModal(interaction) {
  if (!interaction.isModalSubmit()) return false;
  const parts = interaction.customId.split(':');
  if (parts.length < 5 || parts[0] !== 'verify' || parts[1] !== 'modal' || parts[2] !== 'img') return false;
  const challengeId = parts[3];

  const ch = challenges.get(challengeId);
  gcChallenges(Date.now());
  if (!ch) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Captcha scaduto').setDescription('Riprova con `/verify`.')],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (ch.userId !== interaction.user.id) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Non tuo').setDescription('Questo captcha non è tuo.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  const answer = (interaction.fields.getTextInputValue('risposta') || '').trim().toLowerCase();
  if (answer !== ch.correct) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('❌ Sbagliato').setDescription('Riprova con `/verify`.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  challenges.delete(challengeId);
  try {
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) throw new Error('membro non trovato');
    if (!member.roles.cache.has(ch.roleId)) {
      await member.roles.add(ch.roleId, 'verifica completata');
    }
  } catch (err) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Errore').setDescription(`Non ho potuto assegnare il ruolo: ${err.message}. Riprova o contatta uno staff.`)],
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('✅ Verificato').setDescription(`<@&${ch.roleId}> assegnato. Benvenuto!`)],
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = {
  data,
  execute,
  handleComponent,
  handleModal,
  extraCommands: [
    { data: testData, execute: executeTest },
  ],
};
