'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Single responsibility of this file:
//   1. Load .env (Discord secrets only).
//   2. Load config.json (everything else).
//   3. Expose the merged config + a couple of helpers so callers never
//      duplicate the same lookup pattern.
//
// Editing rules:
//   - Tunables, IDs, thresholds: edit config.json.
//   - Bot credentials: edit .env.
//   - Anything new here means adding an accessor below — don't write
//     dotenv / fs.readFileSync logic in other modules.

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(process.cwd(), 'config.json');
const DOTENV_PATH = process.env.DOTENV_PATH || path.join(process.cwd(), '.env');

if (fs.existsSync(DOTENV_PATH)) dotenv.config({ path: DOTENV_PATH });

// --- Loaders --------------------------------------------------------------

function loadJson(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to load ${filepath}: ${err.message}`);
  }
}

function freezeTree(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeTree));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = freezeTree(v);
    return Object.freeze(out);
  }
  return value;
}

function loadConfig() {
  const raw = loadJson(CONFIG_PATH);
  return freezeTree(raw);
}

// --- Accessors ------------------------------------------------------------

const file = loadConfig();
const env = process.env;

// We keep the wrapper object extensible so we can attach getters below.
// The underlying config tree is still frozen to prevent mutation.
const config = {
  file, // raw config.json (frozen), in case callers need to dump it

  get(pathStr, fallback) {
    const parts = pathStr.split('.');
    let cursor = file;
    for (const part of parts) {
      if (cursor == null) return fallback;
      cursor = cursor[part];
    }
    return cursor === undefined ? fallback : cursor;
  },

  resolveChannelId(pathStr, guildOverride) {
    if (guildOverride) return guildOverride;
    const value = this.get(pathStr);
    return value || null;
  },

  requireDiscord() {
    const token = env.DISCORD_BOT_TOKEN;
    const clientId = env.DISCORD_CLIENT_ID;
    if (!token || !clientId) {
      throw new Error('DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID must be set in .env');
    }
    return {
      clientId,
      clientPkey: env.DISCORD_CLIENT_PKEY || '',
      clientSecret: env.DISCORD_CLIENT_SECRET || '',
      botToken: token,
      guildId: env.DISCORD_GUILD_ID || '',
      deployOnStart: file.discord.deployOnStart,
    };
  },

  // Non-secret Discord config (deployOnStart lives here).
  discord() {
    return { deployOnStart: file.discord.deployOnStart };
  },

  redisEnabled() { return Boolean(file.redis.enabled); },
  leaderEnabled() { return Boolean(file.leader.enabled); },
};

// Convenience getters so callers can keep doing `config.redis.host` etc.
Object.defineProperties(config, {
  node: { get: () => file.node, enumerable: true },
  redis: { get: () => file.redis, enumerable: true },
  leader: { get: () => file.leader, enumerable: true },
  database: { get: () => file.database, enumerable: true },
  features: { get: () => file.features, enumerable: true },
  // Non-secret Discord config. Secrets (token/clientId) live in env.
  discord: { get: () => file.discord, enumerable: true },
  // Legacy alias — older code (and shortcuts) referenced `config.db.*`.
  db: { get: () => file.database, enumerable: true },
});

module.exports = config;
