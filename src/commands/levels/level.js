'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const repo = require('../../db/repo');
const { errorEmbed, successEmbed } = require('../../utils/helpers');

const PROGRESS_BAR_SIZE = 20;
const LEADERBOARD_LIMIT = 10;

// --- Definizione comando ---------------------------------------------------

const data = new SlashCommandBuilder()
  .setName('level')
  .setDescription('Sistema livelli')
  .addSubcommand((sc) => sc.setName('rank').setDescription('Mostra il tuo livello').addUserOption((o) => o.setName('utente').setDescription('Di chi mostrare (default: tu)').setRequired(false)))
  .addSubcommand((sc) => sc.setName('leaderboard').setDescription('Classifica XP'))
  .addSubcommand((sc) => sc.setName('set').setDescription("Imposta il livello di un utente (admin)").addUserOption((o) => o.setName('utente').setDescription('Utente').setRequired(true)).addIntegerOption((o) => o.setName('livello').setDescription('Nuovo livello').setMinValue(0).setMaxValue(1000).setRequired(true)))
  .addSubcommand((sc) => sc.setName('addxp').setDescription('Aggiungi XP a un utente').addUserOption((o) => o.setName('utente').setDescription('Utente').setRequired(true)).addIntegerOption((o) => o.setName('importo').setDescription('Quantità di XP').setMinValue(1).setMaxValue(100000).setRequired(true)));

// --- Dispatcher -----------------------------------------------------------

async function execute(interaction) {
  if (!config.features.levels.enabled) return disabled(interaction);
  const handler = SUBCOMMAND_HANDLERS[interaction.options.getSubcommand()];
  if (!handler) return error(interaction, 'Sottocomando sconosciuto.');
  return handler(interaction);
}

const SUBCOMMAND_HANDLERS = {
  rank: cmdRank,
  leaderboard: cmdLeaderboard,
  set: cmdSet,
  addxp: cmdAddXp,
};

// --- Sottocomandi ---------------------------------------------------------

async function cmdRank(interaction) {
  const target = interaction.options.getUser('utente') || interaction.user;
  const user = await repo.getUser(target.id, interaction.guildId);

  const rankList = await repo.topXp(interaction.guildId, 1000);
  const rank = rankList.findIndex((r) => r.user_id === target.id) + 1;

  const xpForCurrent = await repo.xpForLevel(user.level);
  const xpForNext = await repo.xpForLevel(user.level + 1);
  const progress = user.xp - xpForCurrent;
  const needed = Math.max(1, xpForNext - xpForCurrent);
  const pct = Math.min(100, Math.round((progress / needed) * 100));
  const bar = makeProgressBar(pct);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${target.tag} — Livello ${user.level}`)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: 'XP', value: `${user.xp.toLocaleString()} (${progress.toLocaleString()}/${needed.toLocaleString()})`, inline: true },
      { name: 'Posizione', value: rank > 0 ? `#${rank}` : 'non classificato', inline: true },
      { name: 'Messaggi', value: `${user.total_messages}`, inline: true },
      { name: 'Progresso', value: `${bar} ${pct}%` },
    )
    .setTimestamp();
  await interaction.reply({ embeds: [embed] });
}

async function cmdLeaderboard(interaction) {
  const top = await repo.topXp(interaction.guildId, LEADERBOARD_LIMIT);
  if (top.length === 0) return error(interaction, 'Nessun XP registrato.');

  const lines = await Promise.all(top.map(async (r, i) => {
    const tag = await interaction.client.users.fetch(r.user_id).catch(() => null);
    return `**${i + 1}.** ${tag ? tag.tag : r.user_id} — L${r.level} • ${r.xp.toLocaleString()} XP`;
  }));

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Classifica XP')
    .setDescription(lines.join('\n'))
    .setTimestamp();
  await interaction.reply({ embeds: [embed] });
}

async function cmdSet(interaction) {
  const target = interaction.options.getUser('utente');
  const level = interaction.options.getInteger('livello');
  const xp = await repo.xpForLevel(level);
  await repo.updateUser(target.id, interaction.guildId, { xp, level });
  await interaction.reply({ embeds: [successEmbed('Impostato', `<@${target.id}> impostato al livello ${level} (${xp.toLocaleString()} XP).`)] });
}

async function cmdAddXp(interaction) {
  const target = interaction.options.getUser('utente');
  const amount = interaction.options.getInteger('importo');
  const newLevel = await repo.addXp(target.id, interaction.guildId, amount);
  await interaction.reply({ embeds: [successEmbed('Aggiunto', `+${amount} XP a <@${target.id}>. Ora è al livello ${newLevel}.`)] });
}

// --- Helper ---------------------------------------------------------------

function makeProgressBar(percent) {
  const filled = Math.round((percent / 100) * PROGRESS_BAR_SIZE);
  return '█'.repeat(filled) + '░'.repeat(PROGRESS_BAR_SIZE - filled);
}

function disabled(interaction) {
  return interaction.reply({ embeds: [errorEmbed('Disabilitato', 'I livelli sono disabilitati.')], flags: MessageFlags.Ephemeral });
}

function error(interaction, msg) {
  return interaction.reply({ embeds: [errorEmbed('Errore', msg)], flags: MessageFlags.Ephemeral });
}

module.exports = { data, execute };
