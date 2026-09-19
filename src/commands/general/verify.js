'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const repo = require('../../db/repo');
const { hasElevatedPermissions } = require('../../utils/helpers');

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
          .setStyle(n === correct ? ButtonStyle.Success : ButtonStyle.Secondary),
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
          .setStyle(poolIdx === correctIdx ? ButtonStyle.Success : ButtonStyle.Secondary),
      );
    }
    rows.push(row);
  }
  return { kind: 'emo', correct: correctIdx, correctEmoji, rows };
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
  const cfg = await repo.getGuildConfig(interaction.guildId);
  const roleId = cfg.verified_role_id;
  if (!roleId) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Verifica non configurata').setDescription('Il ruolo verificato non è stato impostato. Chiedi a uno staff di configurarlo con `/settings verify role`.').setTimestamp()],
      flags: MessageFlags.Ephemeral,
    });
  }

  const member = interaction.member;
  if (!skipAlreadyVerified && member?.roles?.cache?.has(roleId)) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('Sei già verificato').setDescription(`Hai già il ruolo <@&${roleId}>.`).setTimestamp()],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!skipStaffBypass && hasElevatedPermissions(member)) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('Verifica automatica').setDescription('Hai permessi elevati, sei considerato verificato.').setTimestamp()],
      flags: MessageFlags.Ephemeral,
    });
  }

  // Modalità random: numero o emoji
  const useNumber = Math.random() < 0.5;
  const ch = useNumber ? buildNumberChallenge() : buildEmojiChallenge();

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
  for (const row of ch.rows) {
    for (const btn of row.components) {
      const cur = btn.data.custom_id;
      if (cur && cur.startsWith('verify:captcha:placeholder:')) {
        btn.setCustomId(cur.replace('verify:captcha:placeholder:', `verify:captcha:${challengeId}:`));
      }
    }
  }

  const prompt = ch.kind === 'num'
    ? `Clicca il numero **${ch.correct}**. Hai 2 minuti. (I bottoni verdi sono quelli giusti: ignorali e scegli tu.)`
    : `Clicca l'emoji **${ch.correctEmoji}**. Hai 2 minuti. (I bottoni verdi sono quelli giusti: ignorali e scegli tu.)`;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🔐 Verifica' + (skipAlreadyVerified ? ' (test)' : ''))
    .setDescription(prompt)
    .setFooter({ text: 'Captcha effimero: solo tu puoi vedere questo messaggio.' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], components: ch.rows, flags: MessageFlags.Ephemeral });
}

async function handleComponent(interaction) {
  if (!interaction.isButton()) return false;
  // customId: verify:captcha:<challengeId>:<picked>:<placeholder>
  const parts = interaction.customId.split(':');
  if (parts.length < 5 || parts[0] !== 'verify' || parts[1] !== 'captcha') return false;

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

module.exports = {
  data,
  execute,
  handleComponent,
  extraCommands: [
    { data: testData, execute: executeTest },
  ],
};
