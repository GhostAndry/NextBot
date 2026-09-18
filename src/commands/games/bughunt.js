'use strict';

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const { randomUUID } = require('crypto');
const config = require('../../config');
const repo = require('../../db/repo');
const { errorEmbed, successEmbed } = require('../../utils/helpers');
const logger = require('../../utils/logger');

// /halloween hunt
//   Mini-gioco a griglia ispirato a "mine" / "campo minato". La griglia è NxN
//   (default 5x5). L'utente clicca una cella:
//     - 🪙 gold  → +monete casuali, continua
//     - 🐛 bug   → fine partita, penalità (perdi metà del bet)
//     - ⬜ safe  → cella vuota, fine partita con "hai cashout automatico"
//   La partita termina anche dopo N gold trovati (cashout garantito).
//
// Stato persistito in GameSession (kind "bughunt") per resistere ai restart.

const CMD = 'halloween';
const GAME = 'bughunt';

const data = new SlashCommandBuilder()
  .setName(CMD)
  .setDescription('Mini-giochi a tema Halloween')
  .addSubcommand((sc) => sc.setName('hunt').setDescription('Avvia una partita a Bug Hunting'));

const COOLDOWN_KEY = (uid, gid) => `${gid}:${uid}`;

const cooldowns = new Map();

function getCfg() {
  return config.features.economy.bughunt || {};
}

function betAmount() {
  return getCfg().bet ?? 50;
}

function cooldownSeconds() {
  return getCfg().cooldownSeconds ?? 60;
}

function isEnabled() {
  return Boolean(getCfg().enabled);
}

function makeSession(channelId, userId, guildId) {
  const cfg = getCfg();
  const size = cfg.size ?? 5;
  const bugCount = cfg.bugCount ?? 6;
  const goldCount = cfg.goldCount ?? 8;
  const total = size * size;
  const cells = new Array(total).fill('safe');
  const placeIdx = new Set();
  while (placeIdx.size < bugCount + goldCount) {
    placeIdx.add(Math.floor(Math.random() * total));
  }
  const idxArr = Array.from(placeIdx);
  for (let i = 0; i < bugCount; i++) cells[idxArr[i]] = 'bug';
  for (let i = bugCount; i < bugCount + goldCount; i++) cells[idxArr[i]] = 'gold';

  return {
    userId,
    guildId,
    channelId,
    size,
    cells, // 'safe' | 'bug' | 'gold'
    revealed: new Array(total).fill(false),
    collected: 0, // somma monete raccolte finora
    bet: betAmount(),
    status: 'playing', // 'playing' | 'won' | 'lost'
    finished: false,
    goldRemaining: goldCount,
  };
}

function idxToLabel(idx, size) {
  // 0 -> A1, 4 -> A5, 5 -> B1 ...
  const row = Math.floor(idx / size);
  const col = idx % size;
  return `${String.fromCharCode(65 + row)}${col + 1}`;
}

function labelToIdx(label, size) {
  const m = /^([A-Z])(\d+)$/.exec(label.trim().toUpperCase());
  if (!m) return -1;
  const row = m[1].charCodeAt(0) - 65;
  const col = parseInt(m[2], 10) - 1;
  if (row < 0 || row >= size || col < 0 || col >= size) return -1;
  return row * size + col;
}

function buildEmbed(session, baseTitle = '🎃 Bug Hunting') {
  const statusLabel = session.finished
    ? (session.status === 'won' ? '✅ Sopravvissuto' : '💀 Preso dal bug')
    : `🪙 Raccolto: ${session.collected}`;
  const desc = [
    `**Stato:** ${statusLabel}`,
    session.finished && session.status === 'lost'
      ? `**Penalità:** -${session.bet} monete.`
      : `**Monete vinte:** ${session.collected - session.bet}`,
    '',
    '```',
    renderGrid(session),
    '```',
    `Bet: **${session.bet}** monete.`,
  ].join('\n');

  return new EmbedBuilder()
    .setColor(session.finished ? (session.status === 'won' ? 0x57f287 : 0xed4245) : 0xfee75c)
    .setTitle(baseTitle)
    .setDescription(desc)
    .setFooter({ text: session.finished ? 'Partita terminata' : 'Clicca una cella per rivelarla' });
}

function renderGrid(session) {
  const labels = [];
  for (let i = 0; i < session.size; i++) {
    const letter = String.fromCharCode(65 + i);
    labels.push('   ' + letter);
  }
  const header = labels.join(' ');
  const lines = [header];
  for (let col = 0; col < session.size; col++) {
    const row = [];
    for (let r = 0; r < session.size; r++) {
      const idx = r * session.size + col;
      let ch = '·';
      if (session.revealed[idx]) {
        ch = session.cells[idx] === 'bug' ? 'X' : session.cells[idx] === 'gold' ? 'G' : '·';
      }
      row.push(`${idxToLabel(idx, session.size).slice(1).padStart(2, ' ')} ${ch}`);
    }
    lines.push(row.join(' '));
  }
  return lines.join('\n');
}

function buildGridButtons(session, sessionId) {
  const rows = [];
  for (let r = 0; r < session.size; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < session.size; c++) {
      const idx = r * session.size + c;
      const label = session.finished || session.revealed[idx] ? '·' : idxToLabel(idx, session.size);
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${CMD}:cell:${sessionId}:${idx}`)
          .setLabel(label)
          .setStyle(session.finished ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setDisabled(session.finished || session.revealed[idx])
      );
    }
    rows.push(row);
  }
  // Bottone cashout, sempre in fondo.
  const actionRow = new ActionRowBuilder();
  actionRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`${CMD}:cashout:${sessionId}`)
      .setLabel('Cashout')
      .setStyle(ButtonStyle.Success)
      .setDisabled(session.finished || session.collected === 0)
  );
  rows.push(actionRow);
  return rows;
}

async function execute(interaction) {
  if (!isEnabled()) return interaction.reply({ embeds: [errorEmbed('Disabilitato', 'Il Bug Hunting è disabilitato.')], flags: MessageFlags.Ephemeral });
  if (!config.features.economy.enabled) return interaction.reply({ embeds: [errorEmbed('Errore', 'L\'economia è disabilitata.')], flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand();
  if (sub !== 'hunt') return interaction.reply({ embeds: [errorEmbed('Errore', 'Sottocomando sconosciuto.')], flags: MessageFlags.Ephemeral });

  // Cooldown per utente per guild
  const now = Date.now();
  const last = cooldowns.get(COOLDOWN_KEY(interaction.user.id, interaction.guildId)) || 0;
  const cd = cooldownSeconds();
  if (cd > 0 && now - last < cd * 1000) {
    const left = Math.ceil((cd * 1000 - (now - last)) / 1000);
    return interaction.reply({ embeds: [errorEmbed('Cooldown', `Torna tra ${left}s.`)], flags: MessageFlags.Ephemeral });
  }

  // Verifica bet (l'utente deve avere almeno bet monete in wallet)
  const user = await repo.getUser(interaction.user.id, interaction.guildId);
  if (user.wallet < betAmount()) {
    return interaction.reply({ embeds: [errorEmbed('Povero', `Servono almeno **${betAmount()}** monete in portafoglio.`)], flags: MessageFlags.Ephemeral });
  }
  await repo.updateUser(interaction.user.id, interaction.guildId, { wallet: user.wallet - betAmount() });

  cooldowns.set(COOLDOWN_KEY(interaction.user.id, interaction.guildId), Date.now());

  const session = makeSession(interaction.channelId, interaction.user.id, interaction.guildId);
  const id = randomUUID();
  await repo.saveGameSession(id, interaction.guildId, interaction.channelId, interaction.user.id, GAME, session);

  await interaction.reply({
    embeds: [buildEmbed(session)],
    components: buildGridButtons(session, id),
  });
}

async function handleComponent(interaction) {
  const m = (interaction.customId || '').split(':');
  if (m.length < 4 || m[0] !== CMD) return false;

  const sessionId = m[2];
  const action = m[1];

  const sess = await repo.getGameSession(sessionId);
  if (!sess || sess.game !== GAME) return false;
  const state = sess.state;
  if (state.userId !== interaction.user.id) {
    return interaction.reply({ embeds: [errorEmbed('Errore', 'Questa partita non è tua.')], flags: MessageFlags.Ephemeral });
  }
  if (state.finished) {
    return interaction.update({ embeds: [buildEmbed(state)], components: buildGridButtons(state, sessionId) });
  }

  if (action === 'cashout') {
    await finish(state, sessionId, 'won', interaction);
    return true;
  }
  if (action === 'cell') {
    const idx = parseInt(m[3], 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= state.cells.length) return false;
    await revealCell(state, sessionId, idx, interaction);
    return true;
  }
  return false;
}

async function revealCell(state, sessionId, idx, interaction) {
  if (state.revealed[idx]) return;
  state.revealed[idx] = true;
  const cell = state.cells[idx];

  const cfg = getCfg();
  if (cell === 'bug') {
    state.status = 'lost';
    state.finished = true;
    state.collected = -state.bet; // penalità netta
    await repo.updateUser(state.userId, state.guildId, {});
    await repo.saveGameSession(sessionId, state.guildId, state.channelId, state.userId, GAME, state);
    const embed = buildEmbed(state);
    embed.setDescription(
      `🐛 **Bug trovato!** Hai perso **${state.bet}** monete.\n\n\`\`\`\n${renderGrid(state)}\n\`\`\``
    );
    return interaction.update({ embeds: [embed], components: buildGridButtons(state, sessionId) });
  }

  if (cell === 'gold') {
    const gold = cfg.goldMin + Math.floor(Math.random() * Math.max(1, cfg.goldMax - cfg.goldMin));
    state.collected += gold;
    state.goldRemaining -= 1;
    const user = await repo.getUser(state.userId, state.guildId);
    await repo.updateUser(state.userId, state.guildId, { wallet: user.wallet + gold });
    // Cashout automatico se non resta più gold da trovare
    if (state.goldRemaining <= 0) {
      await finish(state, sessionId, 'won', interaction);
      return;
    }
  }

  // Cella "safe" o "gold" → continua
  await repo.saveGameSession(sessionId, state.guildId, state.channelId, state.userId, GAME, state);
  await interaction.update({ embeds: [buildEmbed(state)], components: buildGridButtons(state, sessionId) });
}

async function finish(state, sessionId, status, interaction) {
  state.status = status;
  state.finished = true;
  await repo.saveGameSession(sessionId, state.guildId, state.channelId, state.userId, GAME, state);
  const embed = buildEmbed(state);
  if (status === 'won') {
    embed.setDescription(
      `✅ **Cashout!** Hai vinto **${state.collected}** monete (bet ${state.bet}).\n\n\`\`\`\n${renderGrid(state)}\n\`\`\``
    );
  }
  return interaction.update({ embeds: [embed], components: buildGridButtons(state, sessionId) });
}

module.exports = {
  data,
  execute,
  handleComponent,
  CMD,
};
