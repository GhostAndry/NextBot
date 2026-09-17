'use strict';

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');
const { initDatabase } = require('../db');
const { registerAll } = require('../handlers/registry');
const voiceTracker = require('./voice-state-tracker');

const REQUIRED_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.DirectMessages,
];

const REQUIRED_PARTIALS = [
  Partials.Channel,
  Partials.Message,
  Partials.GuildMember,
];

async function startLeaderBot() {
  await initDatabase();

  const client = new Client({
    intents: REQUIRED_INTENTS,
    partials: REQUIRED_PARTIALS,
  });

  registerAll(client);

  const credentials = config.requireDiscord();
  await client.login(credentials.botToken);

  await new Promise((resolve) => {
    client.once('ready', () => {
      logger.info(
        {
          user: client.user.tag,
          guilds: client.guilds.cache.size,
          node: config.node.id,
        },
        'bot online as leader',
      );
      // Sincronizza il voiceStateTracker con i canali temp attivi nel DB.
      // Best-effort: se fallisce, riproviamo al primo evento voiceStateUpdate.
      voiceTracker.syncFromDatabase().catch((err) =>
        logger.warn({ err: err.message }, 'voiceTracker sync fallita in ready'),
      );
      resolve();
    });
  });

  return client;
}

async function stopBot(client) {
  if (!client) return;
  try {
    await client.destroy();
  } catch (err) {
    logger.error({ err }, 'client.destroy error');
  }
}

module.exports = { startLeaderBot, stopBot };
