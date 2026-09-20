'use strict';

const path = require('path');
const fs = require('fs');
const { Collection, REST, Routes } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');

// One Collection shared across categories: commands are looked up by name
// regardless of which folder they live in.
const commands = new Collection();
const commandMeta = [];

// --- Category loading ------------------------------------------------------

function loadCategoryCommands(commandsDir, categoryName) {
  const categoryDir = path.join(commandsDir, categoryName);
  if (!fs.existsSync(categoryDir)) return;

  for (const entry of fs.readdirSync(categoryDir)) {
    const fullPath = path.join(categoryDir, entry);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      loadCategoryCommands(categoryDir, entry);
      continue;
    }
    if (!entry.endsWith('.js')) continue;
    registerCommand(fullPath);
  }
}

function registerCommand(filepath) {
  delete require.cache[require.resolve(filepath)];
  const cmd = require(filepath);
  if (!cmd.data || typeof cmd.execute !== 'function') return;
  commands.set(cmd.data.name, cmd);
  commandMeta.push(cmd.data.toJSON());
  logger.debug({ cmd: cmd.data.name }, 'loaded command');

  // Un file può esporre più comandi correlati tramite `extraCommands`
  // (es. verify.js esporta /verify + /verify-test). Ogni entry deve avere
  // la stessa shape { data, execute } (handleComponent opzionale).
  if (Array.isArray(cmd.extraCommands)) {
    for (const extra of cmd.extraCommands) {
      if (!extra?.data || typeof extra.execute !== 'function') continue;
      commands.set(extra.data.name, extra);
      commandMeta.push(extra.data.toJSON());
      logger.debug({ cmd: extra.data.name }, 'loaded extra command');
    }
  }
}

// --- Public API ------------------------------------------------------------

function loadAllCommands() {
  const commandsDir = path.join(__dirname, '..', 'commands');
  const categories = fs.readdirSync(commandsDir).filter((entry) =>
    fs.statSync(path.join(commandsDir, entry)).isDirectory(),
  );
  for (const category of categories) {
    loadCategoryCommands(commandsDir, category);
  }
}

function getCommand(name) {
  return commands.get(name);
}

function listCommands() {
  return Array.from(commands.values());
}

// --- Deploy engine ---------------------------------------------------------

// Resolve credentials + REST client + routes. Returns null when credentials
// are missing so callers can short-circuit cleanly.
function buildRest() {
  let credentials;
  try {
    credentials = config.requireDiscord();
  } catch (err) {
    logger.warn({ err: err.message }, 'discord credentials missing, skipping deploy');
    return null;
  }

  const rest = new REST({ version: '10' }).setToken(credentials.botToken);
  const isGuild = Boolean(credentials.guildId);
  const base = isGuild
    ? Routes.applicationGuildCommands(credentials.clientId, credentials.guildId)
    : Routes.applicationCommands(credentials.clientId);
  const scope = isGuild ? 'guild' : 'global';

  return { rest, credentials, base, scope, isGuild };
}

// Fetch the currently-registered commands for the scope.
async function fetchExisting(rest, base) {
  const existing = await rest.get(base);
  return Array.isArray(existing) ? existing : [];
}

// Compare what's live vs what we have in code. Returns a diff summary.
function diffCommands(existing, fresh) {
  const liveByName = new Map(existing.map((c) => [c.name, c]));
  const freshByName = new Map(fresh.map((c) => [c.name, c]));

  const added = [];
  const updated = [];
  const removed = [];
  const unchanged = [];

  for (const [name, freshCmd] of freshByName) {
    const live = liveByName.get(name);
    if (!live) added.push(name);
    else if (commandsDiffer(live, freshCmd)) updated.push(name);
    else unchanged.push(name);
  }
  for (const name of liveByName.keys()) {
    if (!freshByName.has(name)) removed.push(name);
  }

  return { added, updated, removed, unchanged };
}

// Compare a live command object against the fresh JSON body.
function commandsDiffer(live, fresh) {
  const liveOptions = live.options || [];
  const freshOptions = fresh.options || [];
  return (
    live.description !== fresh.description ||
    JSON.stringify(liveOptions) !== JSON.stringify(freshOptions)
  );
}

// Remove only the commands that no longer exist in code (per name). This is
// safer than PUT [] because untouched commands stay live the whole time — no
// flicker, and commands managed elsewhere are left alone.
async function removeStaleCommands(rest, ctx, existing) {
  const freshNames = new Set(commandMeta.map((c) => c.name));
  const stale = existing.filter((c) => !freshNames.has(c.name));
  for (const cmd of stale) {
    const route = ctx.isGuild
      ? Routes.applicationGuildCommand(ctx.credentials.clientId, ctx.credentials.guildId, cmd.id)
      : Routes.applicationCommand(ctx.credentials.clientId, cmd.id);
    await rest.delete(route);
  }
  return stale.map((c) => c.name);
}

// Wipe every command for the scope (nuclear). Use only to fully reset.
async function wipeAllCommands(rest, base) {
  await rest.put(base, { body: [] });
}

// Remove stale commands (no longer in code) without redeploying anything.
// Returns the list of removed command names.
async function cleanStaleCommands() {
  const ctx = buildRest();
  if (!ctx) return { removed: [], scope: null };

  const existing = await fetchExisting(ctx.rest, ctx.base);
  const removed = await removeStaleCommands(ctx.rest, ctx, existing);
  logger.info({ scope: ctx.scope, removed }, 'cleaned stale commands');
  return { removed, scope: ctx.scope };
}

// Remove specific commands by name (guild or global) without touching others.
async function removeCommandsByName(names) {
  const ctx = buildRest();
  if (!ctx) return { removed: [] };

  const existing = await fetchExisting(ctx.rest, ctx.base);
  const target = new Set(names.map((n) => n.toLowerCase()));
  const toDelete = existing.filter((c) => target.has(c.name.toLowerCase()));

  for (const cmd of toDelete) {
    const route = ctx.isGuild
      ? Routes.applicationGuildCommand(ctx.credentials.clientId, ctx.credentials.guildId, cmd.id)
      : Routes.applicationCommand(ctx.credentials.clientId, cmd.id);
    await ctx.rest.delete(route);
  }
  return { removed: toDelete.map((c) => c.name) };
}

// Enumerate every guild the bot is in.
async function fetchAllGuilds(rest) {
  const guilds = await rest.get(Routes.userGuilds());
  return Array.isArray(guilds) ? guilds : [];
}

// Report every command registered on the account, grouped by location.
// Returns { guilds: [{ id, name, commands: [...] }], global: [...] }.
async function listRegisteredCommands() {
  const ctx = buildRest();
  if (!ctx) return { guilds: [], global: [] };

  const result = { guilds: [], global: [] };

  const guilds = await fetchAllGuilds(ctx.rest);
  for (const guild of guilds) {
    const route = Routes.applicationGuildCommands(ctx.credentials.clientId, guild.id);
    const existing = await fetchExisting(ctx.rest, route);
    result.guilds.push({
      id: guild.id,
      name: guild.name,
      commands: existing.map((c) => c.name),
    });
  }

  const globalRoute = Routes.applicationCommands(ctx.credentials.clientId);
  const globalCmds = await fetchExisting(ctx.rest, globalRoute);
  result.global = globalCmds.map((c) => c.name);

  return result;
}

// Unregister ALL guild-scoped commands across EVERY guild the bot belongs to.
// This is the true "clean the account" operation: it does not look at config
// or at the local command list — it deletes whatever Discord reports as
// registered on each guild. Global commands are left untouched unless
// includeGlobal is set.
async function wipeAllGuildCommands({ includeGlobal = false } = {}) {
  const ctx = buildRest();
  if (!ctx) return { guilds: [], removed: 0 };

  const guilds = await fetchAllGuilds(ctx.rest);
  let removed = 0;

  for (const guild of guilds) {
    const route = Routes.applicationGuildCommands(ctx.credentials.clientId, guild.id);
    const existing = await fetchExisting(ctx.rest, route);

    for (const cmd of existing) {
      const deleteRoute = Routes.applicationGuildCommand(ctx.credentials.clientId, guild.id, cmd.id);
      await ctx.rest.delete(deleteRoute);
      removed += 1;
    }
    logger.info({ guild: guild.id, name: guild.name, removed: existing.length }, 'wiped guild commands');
  }

  if (includeGlobal) {
    const globalRoute = Routes.applicationCommands(ctx.credentials.clientId);
    const globalCmds = await fetchExisting(ctx.rest, globalRoute);
    for (const cmd of globalCmds) {
      const deleteRoute = Routes.applicationCommand(ctx.credentials.clientId, cmd.id);
      await ctx.rest.delete(deleteRoute);
      removed += 1;
    }
    logger.info({ removed: globalCmds.length }, 'wiped global commands');
  }

  logger.info({ guilds: guilds.length, removed }, 'wiped all guild commands');
  return { guilds: guilds.map((g) => g.id), removed };
}

// Main deploy entry. Behavior controlled by flags:
//   wipe    -> wipe everything then redeploy (nuclear reset)
//   dryRun  -> report diff but make no changes
async function deployCommands({ wipe = false, dryRun = false } = {}) {
  const ctx = buildRest();
  if (!ctx) return null;

  const existing = await fetchExisting(ctx.rest, ctx.base);
  const diff = diffCommands(existing, commandMeta);

  if (dryRun) {
    logDiff(ctx.scope, diff);
    return { ...diff, scope: ctx.scope, total: commandMeta.length };
  }

  if (wipe) {
    logger.info({ scope: ctx.scope }, 'wiping all commands then redeploying');
    await wipeAllCommands(ctx.rest, ctx.base);
  } else {
    const removed = await removeStaleCommands(ctx.rest, ctx, existing);
    if (removed.length) {
      logger.info({ scope: ctx.scope, removed }, 'removed stale commands');
    }
  }

  logger.info({ scope: ctx.scope, count: commandMeta.length }, 'deploying slash commands');
  await ctx.rest.put(ctx.base, { body: commandMeta });

  logDiff(ctx.scope, diff);
  return { ...diff, scope: ctx.scope, total: commandMeta.length };
}

function logDiff(scope, diff) {
  logger.info(
    {
      scope,
      added: diff.added,
      updated: diff.updated,
      removed: diff.removed,
      unchanged: diff.unchanged.length,
    },
    'command diff',
  );
}

// --- Event wiring ----------------------------------------------------------

function attachEventHandlers(client) {
  const eventsDir = path.join(__dirname, '..', 'events');
  for (const entry of fs.readdirSync(eventsDir)) {
    if (!entry.endsWith('.js')) continue;
    delete require.cache[require.resolve(path.join(eventsDir, entry))];
    const mod = require(path.join(eventsDir, entry));

    // Raccogliamo gli event handler definiti. Un modulo può esporre:
    //   (a) un singolo evento come `module.exports = { name, execute }`
    //       (es. messageCreate.js) — l'event è il module.exports stesso
    //   (b) più eventi correlati tramite proprietà aggiuntive
    //       (es. ready.js: module.exports.clientReady = { name, execute })
    const events = [];

    // Caso (a): il module.exports stesso è un evento (ha name + execute)
    if (typeof mod.execute === 'function' && typeof mod.name === 'string') {
      events.push({ key: '<module.exports>', evt: mod });
    }

    // Caso (b): proprietà aggiuntive che sono event (es. clientReady)
    for (const [key, value] of Object.entries(mod)) {
      if (key === 'name' || key === 'execute' || key === 'once') continue;
      if (value && typeof value === 'object' && typeof value.execute === 'function' && typeof value.name === 'string') {
        events.push({ key, evt: value });
      }
    }
    if (events.length === 0) continue;

    for (const { key, evt } of events) {
      const handler = (...args) => safeExecute(evt, ...args);
      if (evt.once) client.once(evt.name, handler);
      else client.on(evt.name, handler);

      logger.debug({ evt: evt.name, file: entry, exportKey: key }, 'attached event');
    }
  }
}

async function safeExecute(evt, ...args) {
  try {
    await evt.execute(...args);
  } catch (err) {
    logger.error({ err, evt: evt.name }, 'event handler error');
  }
}

function registerAll(client) {
  loadAllCommands();
  attachEventHandlers(client);
  if (config.discord.deployOnStart) {
    deployCommands().catch((err) => logger.error({ err }, 'deployCommands failed'));
  }
}

module.exports = {
  registerAll,
  getCommand,
  listCommands,
  loadAllCommands,
  deployCommands,
  removeCommandsByName,
  cleanStaleCommands,
  wipeAllCommands,
  wipeAllGuildCommands,
  fetchAllGuilds,
  listRegisteredCommands,
  diffCommands,
  fetchExisting,
};
