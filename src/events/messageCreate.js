'use strict';

const config = require('../config');
const repo = require('../db/repo');
const settingsResolver = require('../services/settings-resolver');
const logger = require('../utils/logger');

// Awards XP on each qualifying message. One message per user per cooldown
// window (default 60s) keeps XP gain tied to genuine participation rather
// than spam. Level-ups trigger one announcement and role rewards.
//
// Tutti i tunables (xpMin/xpMax/cooldown/announceLevelUp) e il canale di
// annuncio accettano un override per-guild via /settings, con fallback al
// valore globale di config.json.

module.exports = {
  name: 'messageCreate',
  async execute(message) {
    if (message.author.bot || !message.guildId) return;

    const enabled = await settingsResolver.getSetting(message.guildId, 'xpEnabled', config.features.levels.enabled);
    if (!enabled) return;

    const cooldown = await settingsResolver.getSetting(message.guildId, 'cooldownSeconds', config.features.levels.cooldownSeconds);
    const xpMin = await settingsResolver.getSetting(message.guildId, 'xpMin', config.features.levels.xpMin);
    const xpMax = await settingsResolver.getSetting(message.guildId, 'xpMax', config.features.levels.xpMax);

    const user = await repo.getUser(message.author.id, message.guildId);
    const now = repo.now();
    if (now - user.last_xp_at < cooldown) return;

    const xpGain = rollXp(xpMin, xpMax);
    const newLevel = await repo.addXp(message.author.id, message.guildId, xpGain);

    if (newLevel <= user.level) return;

    logger.info({ user: message.author.id, guild: message.guildId, level: newLevel }, 'salita di livello');
    await announceLevelUp(message, message.author.id, newLevel);
    await assignLevelRewards(message, newLevel);
  },
};

function rollXp(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function announceLevelUp(message, userId, newLevel) {
  const enabled = await settingsResolver.getSetting(message.guildId, 'announceLevelUp', config.features.levels.announceLevelUp);
  if (!enabled) return;

  const cfg = await repo.getGuildConfig(message.guildId);
  const channelId = cfg.level_announce_channel_id || config.features.levels.announceChannelId;
  const channel = channelId ? message.guild.channels.cache.get(channelId) : message.channel;
  if (!channel?.isTextBased?.()) return;
  await channel.send({
    content: `🎉 <@${userId}> ha raggiunto il **livello ${newLevel}**!`,
    allowedMentions: { parse: ['users'] },
  }).catch(() => {});
}

async function assignLevelRewards(message, newLevel) {
  for (const reward of config.features.levels.rewards) {
    if (reward.level !== newLevel || !reward.roleId) continue;
    const role = message.guild.roles.cache.get(reward.roleId);
    if (role) {
      try { await message.member.roles.add(role, 'ricompensa livello'); }
      catch (err) { logger.warn({ err: err.message }, 'ricompensa ruolo fallita'); }
    }
  }
}
