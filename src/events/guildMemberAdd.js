'use strict';

const repo = require('../db/repo');
const settingsResolver = require('../services/settings-resolver');
const logger = require('../utils/logger');

// Assegna automaticamente il ruolo configurato a chi entra nel server e,
// se configurato, invia un messaggio di benvenuto nel canale dedicato.
//
// L'evento viene chiamato anche per i bot: filtriamo per evitare di
// assegnare ruoli umani ad altri bot. Le eccezioni sono loggate e mai
// rilanciate: un fail di benvenuto/autorole non deve mai rompere il ready.
module.exports = {
  name: 'guildMemberAdd',
  async execute(member) {
    if (!member?.guild) return;
    if (member.user?.bot) return;

    await applyAutoRole(member).catch((err) =>
      logger.warn({ err: err.message, user: member.id, guild: member.guild.id }, 'autorole fallita'),
    );

    await sendWelcome(member).catch((err) =>
      logger.warn({ err: err.message, user: member.id, guild: member.guild.id }, 'welcome fallito'),
    );
  },
};

async function applyAutoRole(member) {
  const enabled = await settingsResolver.getSetting(member.guild.id, 'autoroleEnabled', true);
  if (!enabled) return;

  const cfg = await repo.getGuildConfig(member.guild.id);
  const roleId = cfg.auto_role_id;
  if (!roleId) return;

  const role = member.guild.roles.cache.get(roleId);
  if (!role) {
    logger.warn({ guild: member.guild.id, roleId }, 'autorole: ruolo non trovato');
    return;
  }

  await member.roles.add(role, 'autorole al join');
  logger.debug({ user: member.id, guild: member.guild.id, role: roleId }, 'autorole assegnato');
}

async function sendWelcome(member) {
  const enabled = await settingsResolver.getSetting(member.guild.id, 'welcomeEnabled', false);
  if (!enabled) return;

  const cfg = await repo.getGuildConfig(member.guild.id);
  const channelId = cfg.welcome_channel_id;
  if (!channelId) return;

  const channel = member.guild.channels.cache.get(channelId);
  if (!channel?.isTextBased?.()) return;

  const template = cfg.welcome_message || 'Benvenuto su {server}, {user}!';
  const text = template
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{username}', member.user.username)
    .replaceAll('{server}', member.guild.name);

  await channel.send({ content: text, allowedMentions: { parse: ['users'] } });
}
