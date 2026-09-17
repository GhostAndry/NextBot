'use strict';

const repo = require('../db/repo');
const logger = require('../utils/logger');

// Mapping in-memory dei canali vocali temporanei.
//
// Chiave: `${guildId}:${channelId}` (la guild è ridondante ma aiuta in caso di
// race-condition durante failover/riconnessione). Valore: { ownerId, guildId, hubChannelId }.
//
// Vantaggi rispetto a leggere sempre il DB:
//   - look-up O(1) nei dispatcher dei bottoni/modali (no await)
//   - rinomina automatica del canale in cambio owner
//   - indicizzazione per hub quando si generano nuovi canali temp
//   - se il DB è lento, le operazioni sul canale restano veloci
//
// Il DB resta la fonte di verità. La mappa è una cache che viene popolata:
//   - all'avvio, leggendo tutte le righe TempChannel (sync iniziale)
//   - quando un nuovo canale temp viene aperto (voiceStateUpdate)
//   - quando l'owner cambia (transfer / claim / auto-detected)
// Viene ripulita quando il canale viene eliminato (channelDelete) o quando una
// riga scompare dal DB.

const cache = new Map();

function key(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

function set(guildId, channelId, ownerId, hubChannelId = null) {
  cache.set(key(guildId, channelId), { guildId, channelId, ownerId, hubChannelId });
}

function get(guildId, channelId) {
  return cache.get(key(guildId, channelId)) || null;
}

function getOwnerId(guildId, channelId) {
  const entry = cache.get(key(guildId, channelId));
  return entry?.ownerId || null;
}

function getHubChannelId(guildId, channelId) {
  const entry = cache.get(key(guildId, channelId));
  return entry?.hubChannelId || null;
}

function remove(guildId, channelId) {
  cache.delete(key(guildId, channelId));
}

function list(guildId) {
  const out = [];
  for (const entry of cache.values()) {
    if (entry.guildId === guildId) out.push(entry);
  }
  return out;
}

function listByHub(guildId, hubChannelId) {
  const out = [];
  for (const entry of cache.values()) {
    if (entry.guildId === guildId && entry.hubChannelId === hubChannelId) out.push(entry);
  }
  return out;
}

async function syncFromDatabase(client) {
  // Legge tutti i temp channel attuali e li inserisce in cache.
  // Chiamato all'avvio del bot per partire con lo stato corretto.
  try {
    const rows = await repo.prisma.tempChannel.findMany();
    cache.clear();
    for (const row of rows) {
      set(row.guildId, row.channelId, row.ownerId, row.hubChannelId || null);
    }
    logger.info({ count: rows.length }, 'voiceStateTracker sincronizzato');
  } catch (err) {
    logger.error({ err }, 'voiceStateTracker sync fallita');
  }
  return client;
}

module.exports = {
  set,
  get,
  getOwnerId,
  getHubChannelId,
  remove,
  list,
  listByHub,
  syncFromDatabase,
  key,
};
