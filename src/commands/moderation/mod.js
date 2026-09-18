'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const repo = require('../../db/repo');
const settingsResolver = require('../../services/settings-resolver');
const { successEmbed, errorEmbed, modEmbed, parseDuration, formatDuration } = require('../../utils/helpers');
const logger = require('../../utils/logger');

const DEFAULT_DELETE_DAYS = 0;
const REASON_FALLBACK = 'Nessun motivo';

// --- Definizione comando ---------------------------------------------------

const data = new SlashCommandBuilder()
  .setName('mod')
  .setDescription('Comandi di moderazione')
  .addSubcommand((sc) => sc.setName('ban').setDescription('Banna un utente').addUserOption((o) => o.setName('utente').setDescription('Utente da bannare').setRequired(true)).addStringOption((o) => o.setName('motivo').setDescription('Motivo').setRequired(false)).addStringOption((o) => o.setName('durata').setDescription('Es. 7d, 12h').setRequired(false)).addIntegerOption((o) => o.setName('giorni_messaggi').setDescription('Giorni di cronologia da eliminare (0-7)').setMinValue(0).setMaxValue(7).setRequired(false)))
  .addSubcommand((sc) => sc.setName('kick').setDescription('Espelli un utente').addUserOption((o) => o.setName('utente').setDescription('Utente da espellere').setRequired(true)).addStringOption((o) => o.setName('motivo').setDescription('Motivo').setRequired(false)))
  .addSubcommand((sc) => sc.setName('mute').setDescription('Silenzia un utente').addUserOption((o) => o.setName('utente').setDescription('Utente da silenziare').setRequired(true)).addStringOption((o) => o.setName('durata').setDescription('Es. 10m, 1h, 1d').setRequired(true)).addStringOption((o) => o.setName('motivo').setDescription('Motivo').setRequired(false)))
  .addSubcommand((sc) => sc.setName('unmute').setDescription('Rimuovi il timeout da un utente').addUserOption((o) => o.setName('utente').setDescription('Utente da riattivare').setRequired(true)))
  .addSubcommand((sc) => sc.setName('warn').setDescription('Avvisa un utente').addUserOption((o) => o.setName('utente').setDescription('Utente da avvisare').setRequired(true)).addStringOption((o) => o.setName('motivo').setDescription('Motivo').setRequired(true)))
  .addSubcommand((sc) => sc.setName('warnings').setDescription('Mostra gli avvisi di un utente').addUserOption((o) => o.setName('utente').setDescription('Di chi mostrare gli avvisi').setRequired(true)))
  .addSubcommand((sc) => sc.setName('clearwarns').setDescription('Cancella gli avvisi di un utente').addUserOption((o) => o.setName('utente').setDescription('Di chi cancellare gli avvisi').setRequired(true)))
  .addSubcommand((sc) => sc.setName('purge').setDescription('Elimina messaggi in blocco').addIntegerOption((o) => o.setName('quantita').setDescription('1-100').setMinValue(1).setMaxValue(100).setRequired(true)).addUserOption((o) => o.setName('utente').setDescription('Elimina solo i messaggi di questo utente').setRequired(false)))
  .addSubcommand((sc) => sc.setName('slowmode').setDescription('Imposta la modalità lenta (0 per disattivare)').addIntegerOption((o) => o.setName('secondi').setDescription('Durata in secondi (0 per disattivare)').setMinValue(0).setMaxValue(21600).setRequired(true)))
  .addSubcommand((sc) => sc.setName('lock').setDescription('Blocca un canale').addChannelOption((o) => o.setName('canale').setDescription('Canale da bloccare (default: attuale)').setRequired(false)))
  .addSubcommand((sc) => sc.setName('unlock').setDescription('Sblocca un canale').addChannelOption((o) => o.setName('canale').setDescription('Canale da sbloccare (default: attuale)').setRequired(false)))
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);

// --- Dispatcher -----------------------------------------------------------

async function execute(interaction) {
  if (!config.features.moderation.enabled) {
    return replyDisabled(interaction);
  }

  const handler = SUBCOMMAND_HANDLERS[interaction.options.getSubcommand()];
  if (!handler) return replyError(interaction, 'Sottocomando sconosciuto.');
  return handler(interaction);
}

const SUBCOMMAND_HANDLERS = {
  ban: cmdBan,
  kick: cmdKick,
  mute: cmdMute,
  unmute: cmdUnmute,
  warn: cmdWarn,
  warnings: cmdWarnings,
  clearwarns: cmdClearwarns,
  purge: cmdPurge,
  slowmode: cmdSlowmode,
  lock: cmdLock,
  unlock: cmdUnlock,
};

// --- Sottocomandi ---------------------------------------------------------

async function cmdBan(interaction) {
  const target = interaction.options.getUser('utente');
  const reason = interaction.options.getString('motivo') || REASON_FALLBACK;
  const durationStr = interaction.options.getString('durata');
  const deleteDays = interaction.options.getInteger('giorni_messaggi') || DEFAULT_DELETE_DAYS;

  // Evita self-ban e ban su utenti con permessi superiori al moderator.
  if (target.id === interaction.user.id) return replyError(interaction, 'Non puoi bannare te stesso.');
  if (target.id === interaction.guild.ownerId) return replyError(interaction, 'Non puoi bannare il proprietario del server.');

  const member = await fetchMember(interaction, target.id);
  if (member && !canModerate(interaction.member, member)) return replyError(interaction, 'Non posso bannare questo utente (ruolo troppo alto).');
  if (member && !member.bannable) return replyError(interaction, 'Non posso bannare questo utente.');

  const duration = parseDuration(durationStr);

  if (duration) {
    await interaction.guild.members.ban(target.id, { reason, deleteMessageSeconds: deleteDays * 86400 });
    await repo.addModLog(interaction.guildId, 'ban_temp', target.id, interaction.user.id, reason, duration);
    scheduleTempUnban(interaction.guild, target.id, duration);
    await reply(interaction, successEmbed('Bannato', `<@${target.id}> bannato per ${formatDuration(duration)}.`));
    log(interaction, modEmbed('Ban (temporaneo)', target, interaction.user, reason, { durata: formatDuration(duration) }));
    return;
  }

  await interaction.guild.members.ban(target.id, { reason, deleteMessageSeconds: deleteDays * 86400 });
  await repo.addModLog(interaction.guildId, 'ban', target.id, interaction.user.id, reason, null);
  await reply(interaction, successEmbed('Bannato', `<@${target.id}> bannato.`));
  log(interaction, modEmbed('Ban', target, interaction.user, reason));
}

async function cmdKick(interaction) {
  const target = interaction.options.getUser('utente');
  const reason = interaction.options.getString('motivo') || REASON_FALLBACK;

  if (target.id === interaction.user.id) return replyError(interaction, 'Non puoi espellere te stesso.');
  if (target.id === interaction.guild.ownerId) return replyError(interaction, 'Non puoi espellere il proprietario del server.');

  const member = await fetchMember(interaction, target.id);
  if (!member) return replyError(interaction, 'Utente non presente nel server.');
  if (!canModerate(interaction.member, member)) return replyError(interaction, 'Non posso espellere questo utente (ruolo troppo alto).');
  if (!member.kickable) return replyError(interaction, 'Non posso espellere questo utente.');

  await member.kick(reason);
  await repo.addModLog(interaction.guildId, 'kick', target.id, interaction.user.id, reason, null);

  await reply(interaction, successEmbed('Espulso', `<@${target.id}> espulso.`));
  log(interaction, modEmbed('Kick', target, interaction.user, reason));
}

async function cmdMute(interaction) {
  const target = interaction.options.getUser('utente');
  const reason = interaction.options.getString('motivo') || REASON_FALLBACK;
  const durationStr = interaction.options.getString('durata');
  const duration = parseDuration(durationStr);
  if (!duration) return replyError(interaction, 'Usa una durata valida come 10m, 1h, 1d.');

  if (target.id === interaction.user.id) return replyError(interaction, 'Non puoi silenziare te stesso.');
  if (target.id === interaction.guild.ownerId) return replyError(interaction, 'Non puoi silenziare il proprietario del server.');

  const member = await fetchMember(interaction, target.id);
  if (!member) return replyError(interaction, 'Utente non presente nel server.');
  if (!canModerate(interaction.member, member)) return replyError(interaction, 'Non posso silenziare questo utente (ruolo troppo alto).');
  if (!member.moderatable) return replyError(interaction, 'Non posso silenziare questo utente.');

  await member.timeout(duration, reason);
  await repo.addModLog(interaction.guildId, 'mute', target.id, interaction.user.id, reason, duration);

  await reply(interaction, successEmbed('Silenziato', `<@${target.id}> silenziato per ${formatDuration(duration)}.`));
  log(interaction, modEmbed('Mute', target, interaction.user, reason, { durata: formatDuration(duration) }));
}

async function cmdUnmute(interaction) {
  const target = interaction.options.getUser('utente');
  const member = await fetchMember(interaction, target.id);
  if (!member) return replyError(interaction, 'Utente non presente nel server.');

  await member.timeout(null, 'unmute');
  await repo.addModLog(interaction.guildId, 'unmute', target.id, interaction.user.id, null, null);

  await reply(interaction, successEmbed('Riattivato', `Timeout rimosso da <@${target.id}>.`));
}

async function cmdWarn(interaction) {
  const target = interaction.options.getUser('utente');
  const reason = interaction.options.getString('motivo');

  await repo.addWarn(interaction.guildId, target.id, interaction.user.id, reason);
  await repo.addModLog(interaction.guildId, 'warn', target.id, interaction.user.id, reason, null);

  const total = await repo.countWarns(interaction.guildId, target.id);
  await reply(interaction, successEmbed('Avvisato', `<@${target.id}> avvisato. Totale: ${total}.`));
  log(interaction, modEmbed('Warn', target, interaction.user, reason, { totale: total }));

  await maybeAutoMute(interaction, target.id, total);
}

async function cmdWarnings(interaction) {
  const target = interaction.options.getUser('utente');
  const warns = await repo.getWarns(interaction.guildId, target.id);

  if (warns.length === 0) {
    return reply(interaction, successEmbed('Nessun avviso', `<@${target.id}> non ha avvisi.`), { flags: MessageFlags.Ephemeral });
  }

  const lines = warns.slice(0, 10).map((w, i) =>
    `**${i + 1}.** <t:${w.created_at}:R> da <@${w.moderator_id}> — ${w.reason || 'nessun motivo'}`,
  );
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`Avvisi di ${target.tag}`).setDescription(lines.join('\n'));
  return reply(interaction, embed, { flags: MessageFlags.Ephemeral });
}

async function cmdClearwarns(interaction) {
  const target = interaction.options.getUser('utente');
  await repo.clearWarns(interaction.guildId, target.id);
  await repo.addModLog(interaction.guildId, 'clearwarns', target.id, interaction.user.id, null, null);
  return reply(interaction, successEmbed('Cancellati', `Avvisi di <@${target.id}> cancellati.`), { flags: MessageFlags.Ephemeral });
}

async function cmdPurge(interaction) {
  const amount = interaction.options.getInteger('quantita');
  const targetUser = interaction.options.getUser('utente');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let messages = await interaction.channel.messages.fetch({ limit: 100 });
  if (targetUser) messages = messages.filter((m) => m.author.id === targetUser.id);
  messages = [...messages.values()].slice(0, amount);
  if (messages.length === 0) return interaction.editReply({ embeds: [errorEmbed('Niente da eliminare', 'Nessun messaggio trovato.')] });

  const deleted = await interaction.channel.bulkDelete(messages, true).catch((err) => ({ size: 0, err }));
  const deletedCount = deleted.size || messages.length;
  await repo.addModLog(interaction.guildId, 'purge', interaction.channelId, interaction.user.id, `eliminati ${deletedCount}`, null);

  await interaction.editReply({ embeds: [successEmbed('Eliminati', `Eliminati ${deletedCount} messaggi.`)] });
}

async function cmdSlowmode(interaction) {
  const seconds = interaction.options.getInteger('secondi');
  await interaction.channel.setRateLimitPerUser(seconds, 'modifica slowmode');
  const msg = seconds === 0 ? 'Modalità lenta disattivata.' : `Modalità lenta impostata a ${seconds}s.`;
  return reply(interaction, successEmbed('Slowmode', msg), { flags: MessageFlags.Ephemeral });
}

async function cmdLock(interaction) {
  const channel = interaction.options.getChannel('canale') || interaction.channel;
  await channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: false }, { reason: 'canale bloccato' });
  return reply(interaction, successEmbed('Bloccato', `${channel} bloccato.`), { flags: MessageFlags.Ephemeral });
}

async function cmdUnlock(interaction) {
  const channel = interaction.options.getChannel('canale') || interaction.channel;
  await channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: null }, { reason: 'canale sbloccato' });
  return reply(interaction, successEmbed('Sbloccato', `${channel} sbloccato.`), { flags: MessageFlags.Ephemeral });
}

// --- Helper ---------------------------------------------------------------

async function fetchMember(interaction, userId) {
  return interaction.guild.members.fetch(userId).catch(() => null);
}

// Verifica gerarchia ruoli: il moderator deve avere un ruolo più alto del
// target, altrimenti non può (e non dovrebbe poterlo) moderarlo.
// Il proprietario del guild può moderare chiunque (gestito dal chiamante con
// check separato su guild.ownerId).
function canModerate(moderator, target) {
  if (!moderator || !target) return false;
  // Il proprietario del guild può moderare tutti.
  if (moderator.id === moderator.guild.ownerId) return true;
  // Non puoi moderare chi è sopra di te.
  return moderator.roles.highest.comparePositionTo(target.roles.highest) > 0;
}

function scheduleTempUnban(guild, userId, durationMs) {
  setTimeout(async () => {
    try {
      await guild.members.unban(userId, 'ban temporaneo scaduto');
    } catch (err) {
      logger.warn({ err: err.message, userId }, 'unban temporaneo fallito');
    }
  }, durationMs);
}

async function maybeAutoMute(interaction, userId, warnCount) {
  const maxWarns = await settingsResolver.getSetting(interaction.guildId, 'maxWarns', config.features.moderation.maxWarns);
  const action = await settingsResolver.getSetting(interaction.guildId, 'warnAction', config.features.moderation.warnAction);

  if (warnCount < maxWarns) return;
  if (action === 'none') return;

  const member = await fetchMember(interaction, userId);
  if (!member?.moderatable) return;

  try {
    if (action === 'mute') {
      await member.timeout(60 * 60 * 1000, 'raggiunto il numero massimo di avvisi');
    } else if (action === 'kick') {
      await member.kick('raggiunto il numero massimo di avvisi');
    } else if (action === 'ban') {
      await member.ban({ reason: 'raggiunto il numero massimo di avvisi' });
    }
  } catch (err) {
    logger.warn({ err: err.message, userId, action }, 'auto-azione fallita');
  }
}

function replyDisabled(interaction) {
  return interaction.reply({ embeds: [errorEmbed('Disabilitato', 'La moderazione è disabilitata.')], flags: MessageFlags.Ephemeral });
}

function replyError(interaction, message) {
  return reply(interaction, errorEmbed('Errore', message), { flags: MessageFlags.Ephemeral });
}

async function reply(interaction, payload, options = {}) {
  return interaction.reply({ embeds: [payload], ...options });
}

async function log(interaction, embed) {
  // Preferisci l'override per-guild (DB) sul valore globale di config.json.
  const cfg = await repo.getGuildConfig(interaction.guildId);
  const logId = cfg.mod_log_channel_id || config.features.moderation.logChannelId;
  if (!logId) return;
  const channel = interaction.guild.channels.cache.get(logId);
  if (channel) channel.send({ embeds: [embed] }).catch(() => {});
}

module.exports = { data, execute };
