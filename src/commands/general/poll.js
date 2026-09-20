'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const logger = require('../../utils/logger');

// Poll con bottoni. Opzioni: 2-5 opzioni testo. Ogni utente può votare UNA volta
// per opzione; può cambiare idea cliccando un'altra opzione. I bottoni sono
// customId `poll:vote:<pollId>:<optionIdx>` così il dispatcher può aggiornare
// il contatore.
//
// NB: i voti sono in memoria (Map). Al restart del bot si azzerano. Per ora
// non serve persistenza (un poll è effimero); se servirà si aggiunge una
// tabella PollVote su GuildConfig-side.

const polls = new Map();
const POLL_TTL_MS = 24 * 60 * 60 * 1000;

function makePollId() {
  return Math.random().toString(16).slice(2, 10);
}

function gcPolls(now) {
  for (const [id, p] of polls) {
    if (p.expiresAt <= now) polls.delete(id);
  }
}

const data = new SlashCommandBuilder()
  .setName('poll')
  .setDescription('Crea un sondaggio con bottoni (2-5 opzioni)')
  .addStringOption((o) =>
    o.setName('domanda').setDescription('La domanda del sondaggio').setRequired(true).setMaxLength(200))
  .addStringOption((o) =>
    o.setName('opzione1').setDescription('Opzione 1').setRequired(true).setMaxLength(80))
  .addStringOption((o) =>
    o.setName('opzione2').setDescription('Opzione 2').setRequired(true).setMaxLength(80))
  .addStringOption((o) =>
    o.setName('opzione3').setDescription('Opzione 3 (opzionale)').setRequired(false).setMaxLength(80))
  .addStringOption((o) =>
    o.setName('opzione4').setDescription('Opzione 4 (opzionale)').setRequired(false).setMaxLength(80))
  .addStringOption((o) =>
    o.setName('opzione5').setDescription('Opzione 5 (opzionale)').setRequired(false).setMaxLength(80))
  .addBooleanOption((o) =>
    o.setName('multi').setDescription('Consenti più voti per utente (default false)').setRequired(false));

// Emojis per i bottoni
const BTN_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

async function execute(interaction) {
  const domanda = interaction.options.getString('domanda');
  const opts = [];
  for (let i = 1; i <= 5; i++) {
    const v = interaction.options.getString(`opzione${i}`);
    if (v && v.trim()) opts.push(v.trim());
  }
  if (opts.length < 2) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Troppo poche opzioni').setDescription('Servono almeno 2 opzioni (massimo 5).').setTimestamp()],
      flags: MessageFlags.Ephemeral,
    });
  }
  const multi = interaction.options.getBoolean('multi') || false;

  const pollId = makePollId();
  gcPolls(Date.now());
  polls.set(pollId, {
    domanda,
    opts,
    multi,
    voters: new Map(), // userId -> Set(optionIdx) o optionIdx singolo
    authorId: interaction.user.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    expiresAt: Date.now() + POLL_TTL_MS,
  });

  const rows = [];
  const row = new ActionRowBuilder();
  for (let i = 0; i < opts.length; i++) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`poll:vote:${pollId}:${i}`)
        .setLabel(BTN_EMOJI[i])
        .setStyle(ButtonStyle.Primary),
    );
  }
  rows.push(row);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📊 ${domanda}`)
    .setDescription(opts.map((o, i) => `${BTN_EMOJI[i]} ${o}`).join('\n'))
    .setFooter({ text: `Poll di ${interaction.user.tag} • ${multi ? 'multi-voto' : 'un voto per utente'}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], components: rows });
}

async function handleComponent(interaction) {
  if (!interaction.isButton()) return false;
  const parts = interaction.customId.split(':');
  if (parts.length !== 4 || parts[0] !== 'poll' || parts[1] !== 'vote') return false;
  const pollId = parts[2];
  const optIdx = parseInt(parts[3], 10);
  if (!Number.isFinite(optIdx)) return false;

  const poll = polls.get(pollId);
  if (!poll) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Poll scaduto').setDescription('Questo sondaggio non esiste più.')],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (optIdx < 0 || optIdx >= poll.opts.length) return false;

  // Aggiorna voti
  const userId = interaction.user.id;
  if (poll.multi) {
    if (!poll.voters.has(userId)) poll.voters.set(userId, new Set());
    const set = poll.voters.get(userId);
    if (set.has(optIdx)) set.delete(optIdx);
    else set.add(optIdx);
  } else {
    const current = poll.voters.get(userId);
    if (current === optIdx) {
      // toggle off
      poll.voters.delete(userId);
    } else {
      poll.voters.set(userId, optIdx);
    }
  }

  // Ricalcola conteggi
  const counts = new Array(poll.opts.length).fill(0);
  if (poll.multi) {
    for (const set of poll.voters.values()) {
      for (const idx of set) counts[idx] = (counts[idx] || 0) + 1;
    }
  } else {
    for (const idx of poll.voters.values()) counts[idx] = (counts[idx] || 0) + 1;
  }
  const totalVoters = poll.multi
    ? [...poll.voters.values()].reduce((sum, set) => sum + set.size, 0)
    : poll.voters.size;

  // Ricostruisci righe bottoni con conteggi nelle label
  const newRow = new ActionRowBuilder();
  for (let i = 0; i < poll.opts.length; i++) {
    const myVote = poll.multi
      ? (poll.voters.get(userId)?.has(i) ?? false)
      : poll.voters.get(userId) === i;
    newRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`poll:vote:${pollId}:${i}`)
        .setLabel(`${BTN_EMOJI[i]} ${counts[i]}`)
        .setStyle(myVote ? ButtonStyle.Success : ButtonStyle.Primary),
    );
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📊 ${poll.domanda}`)
    .setDescription(poll.opts.map((o, i) => {
      const c = counts[i];
      const pct = totalVoters > 0 ? Math.round((c / totalVoters) * 100) : 0;
      const bar = renderBar(pct);
      return `${BTN_EMOJI[i]} **${o}** — ${c} voto${c === 1 ? '' : 'i'} (${pct}%)\n${bar}`;
    }).join('\n\n'))
    .setFooter({ text: `Poll di ${(await getUserTag(interaction, poll.authorId))} • ${totalVoters} votanti` })
    .setTimestamp();

  await interaction.update({ embeds: [embed], components: [newRow] });
  return true;
}

function renderBar(pct) {
  const filled = Math.round(pct / 10);
  const empty = 10 - filled;
  return '`' + '█'.repeat(filled) + '░'.repeat(empty) + '`';
}

async function getUserTag(interaction, userId) {
  try {
    return (await interaction.client.users.fetch(userId)).tag;
  } catch (_) {
    return userId;
  }
}

module.exports = { data, execute, handleComponent };
