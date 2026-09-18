'use strict';

const config = require('../config');
const repo = require('../db/repo');
const settingsResolver = require('../services/settings-resolver');
const voiceTracker = require('../services/voice-state-tracker');
const logger = require('../utils/logger');
const tempChannelModule = require('../commands/voice/tempchannel');

// Quando un utente entra in un hub vocale configurato, crea un canale privato
// e lo sposta lì. Quando un canale tracciato si svuota, pianifica la cancellazione
// dopo il periodo di grazia. Per ogni canale creato, il sistema invia un
// pannello di controllo (bottoni) che permette all'owner di rinominare,
// bloccare, limitare, cacciare, trasferire la proprietà, claim orfani.
//
// Supporta più hub per guild: VoiceHub.channelId identifica il "generatore".
// Quando un utente entra in un hub qualsiasi, il temp voice creato è "sotto"
// lo stesso parent dell'hub.
//
// Tutti i canali temp creati qui vengono:
//   - aggiunti al voiceTracker (cache in-memory per lookup O(1))
//   - rinominati con prefisso 👑 + nome utente (marker owner, stile VoiceMaster)
//
// Risoluzione dell'hub e dei tunables: override per-guild (DB) > config globale.

const OWNER_PREFIX = '👑 ';
const pendingDeletes = new Map();
// Protegge dal invio multiplo del pannello di controllo: anche se lo stesso
// canale triggera Caso 3 più volte, il pannello arriva una volta sola.
const panelSentFor = new Set();

module.exports = {
  name: 'voiceStateUpdate',
  invalidateHubCache,
  liveSyncVoiceRoom,
  clearPanelSent,
  async execute(oldState, newState) {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;
    const enabled = await settingsResolver.getSetting(guild.id, 'tempChannelsEnabled', config.features.tempChannels.enabled);
    if (!enabled) return;

    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    // Cache locale della mappa hub-channelIds per la guild (TTL 30s per
    // evitare di rifare la query ad ogni evento).
    const hubIds = await getHubIdsForGuild(guild.id);

    // Caso 1: utente entra in un hub → crea temp voice (o riusa uno esistente).
    if (newState.channelId && hubIds.has(newState.channelId) && oldState.channelId !== newState.channelId) {
      const hubChannel = newState.guild.channels.cache.get(newState.channelId);
      await createTempVoice(guild, hubChannel?.parent, member, newState.channelId);
    }

    // Caso 2: utente lascia un canale non-hub → schedula cancellazione se vuoto.
    if (oldState.channelId && !hubIds.has(oldState.channelId)) {
      await scheduleEmptyDelete(oldState);
    }

    // Caso 3: utente entra in un nuovo canale non-hub → se è un temp voice,
    // applichiamo enforcement e inviamo il pannello di controllo.
    if (
      newState.channelId &&
      !hubIds.has(newState.channelId) &&
      (!oldState.channelId || hubIds.has(oldState.channelId))
    ) {
      const channel = newState.guild.channels.cache.get(newState.channelId);
      if (channel) {
        const temp = await repo.getTempChannel(channel.id);
        if (temp && temp.kind === 'voice') {
          await enforceBlockedAndLocked(channel, temp);
          // Anti-doppio-pannello: se Caso 3 viene triggerato più volte per lo
          // stesso canale (es. self-deaf toggle, riconnessioni), inviamo solo
          // il primo. Si resetta quando il canale viene eliminato (channelDelete).
          if (!panelSentFor.has(channel.id)) {
            panelSentFor.add(channel.id);
            tempChannelModule.sendControlPanel(channel);
          }
        }
      }
    }
  },
  renameForNewOwner,
  OWNER_PREFIX,
};

function clearPanelSent(channelId) {
  if (channelId) panelSentFor.delete(channelId);
  else panelSentFor.clear();
}

// Cache locale degli hub per guild (TTL 30s). Evita di rifare la query su
// ogni evento voiceStateUpdate.
const hubCache = new Map();
const HUB_CACHE_TTL_MS = 30 * 1000;

async function getHubIdsForGuild(guildId) {
  const now = Date.now();
  const cached = hubCache.get(guildId);
  if (cached && cached.expires > now) return cached.ids;

  const ids = new Set(await repo.getHubChannelIds(guildId));
  hubCache.set(guildId, { ids, expires: now + HUB_CACHE_TTL_MS });
  return ids;
}

function invalidateHubCache(guildId) {
  if (guildId) hubCache.delete(guildId);
  else hubCache.clear();
}

async function enforceBlockedAndLocked(channel, temp) {
  // Rispetta la modalità lock + il blocco per singolo utente.
  if (!temp.locked && !(temp.blocked && temp.blocked.length)) return;
  const allow = new Set([temp.owner_id, channel.guild.members.me.id]);
  for (const [, member] of channel.members) {
    if (allow.has(member.id)) continue;
    const blocked = Array.isArray(temp.blocked) && temp.blocked.includes(member.id);
    if (blocked || temp.locked) {
      try { await member.voice.setChannel(null, blocked ? 'voice blocked' : 'voice locked'); } catch (_) {}
    }
  }
}

async function createTempVoice(guild, parent, member, hubChannelId) {
  try {
    // Prima di creare un nuovo canale, cerchiamo se l'owner ha già un temp
    // voice attivo per lo stesso hub (riga su TempChannel la cui cache lato
    // discord è ancora esistente). Se sì, spostiamo l'utente lì dentro e
    // usciamo — niente nuovo canale, niente canale "orfano" che si svuota.
    const ownerChannels = await repo.getTempChannelsByOwner(guild.id, member.id);
    const existing = ownerChannels.find((t) => t.hub_channel_id === hubChannelId && t.kind === 'voice');
    if (existing) {
      const live = guild.channels.cache.get(existing.channel_id);
      if (live) {
        try {
          await member.voice.setChannel(live, 'canale temp già esistente');
          logger.info({ channel: live.id, owner: member.id, hub: hubChannelId }, 'owner riciclato su canale esistente');
          return;
        } catch (err) {
          logger.warn({ err: err.message }, 'riciclo canale esistente fallito, ne creo uno nuovo');
        }
      }
    }

    const defaultUserLimit = await settingsResolver.getSetting(guild.id, 'defaultUserLimit', config.features.tempChannels.defaultUserLimit);

    // Se l'owner ha già un VoiceRoom per questo hub, ripristiniamo le sue
    // impostazioni (locked, blocked, name, userLimit) altrimenti usiamo i
    // defaults globali/per-guild.
    const snapshot = await repo.getVoiceRoom(guild.id, member.id, hubChannelId);
    let snapshotSettings = {};
    let locked = 0;
    let initialUserLimit = defaultUserLimit;
    if (snapshot) {
      snapshotSettings = parseSettingsBlob(snapshot.settings);
      locked = snapshot.locked || 0;
      if (Number.isInteger(snapshotSettings.userLimit)) initialUserLimit = snapshotSettings.userLimit;
    }

    const displayName = formatOwnerName(member.user.username);
    const channel = await guild.channels.create({
      name: displayName,
      type: 2,
      parent,
      userLimit: initialUserLimit,
      reason: 'Canale vocale temporaneo',
    });

    // Apri il canale live. Salviamo blocked + locked dallo snapshot se presenti,
    // altrimenti la riga parte "pulita".
    await repo.openTempChannel(channel.id, guild.id, member.id, 'voice', hubChannelId);
    if (snapshot) {
      const blocked = Array.isArray(snapshot.blocked) ? snapshot.blocked : [];
      await prisma_tempChannel_updateBlocked(channel.id, blocked, locked ? 1 : 0);
    }

    voiceTracker.set(guild.id, channel.id, member.id, hubChannelId);

    // Se lo snapshot era lockato, applichiamo il lock al canale live.
    if (locked) {
      try {
        await channel.permissionOverwrites.edit(guild.id, { Connect: false }, { reason: 'voice lock ripristinato' });
      } catch (_) {}
    }

    await member.voice.setChannel(channel, 'canale temporaneo creato');
    logger.info({ channel: channel.id, owner: member.id, hub: hubChannelId, restored: Boolean(snapshot) }, 'canale vocale temporaneo creato');
  } catch (err) {
    logger.error({ err }, 'creazione canale temporaneo fallita');
  }
}

// Helper che aggiorna in place la riga TempChannel quando vogliamo impostare
// blocked/locked dalla snapshot. Centralizzato per leggibilità.
async function prisma_tempChannel_updateBlocked(channelId, blocked, locked) {
  await repo.prisma.tempChannel.update({
    where: { channelId },
    data: { blocked: JSON.stringify(blocked), locked },
  }).catch((err) => logger.warn({ err: err.message, channelId }, 'ripristino snapshot parziale'));
}

function parseSettingsBlob(blob) {
  if (!blob) return {};
  try {
    const p = JSON.parse(blob);
    return p && typeof p === 'object' ? p : {};
  } catch (_) {
    return {};
  }
}

// Sincronizza lo stato live del canale (locked, blocked, userLimit, name)
// sullo snapshot VoiceRoom. Viene chiamato da /voice <lock|unlock|kick|permit|
// limit|rename|transfer> in modo che se il canale viene eliminato all'improvviso
// (es. server ruolo disconnesso, bot rimosso), al rientro abbiamo già le
// impostazioni aggiornate.
async function liveSyncVoiceRoom(channel, temp) {
  if (!channel || !temp || !temp.owner_id) return;
  const hubId = temp.hub_channel_id;
  if (!hubId) return;
  try {
    await repo.saveVoiceRoom(temp.guild_id || channel.guild.id, temp.owner_id, hubId, {
      locked: temp.locked ? 1 : 0,
      blocked: Array.isArray(temp.blocked) ? temp.blocked : [],
      settings: JSON.stringify({
        userLimit: channel.userLimit ?? 0,
        name: channel.name,
      }),
    });
  } catch (err) {
    logger.warn({ err: err.message, channel: channel.id }, 'liveSyncVoiceRoom fallito');
  }
}

// Formatta il nome del canale con marker 👑. Rimuove l'eventuale prefisso
// già presente per evitare 👑 👑 username quando l'owner viene trasferito.
function formatOwnerName(username) {
  const clean = stripOwnerPrefix(username);
  return `${OWNER_PREFIX}${clean}'s room`.slice(0, 90);
}

function stripOwnerPrefix(name) {
  return name && name.startsWith(OWNER_PREFIX) ? name.slice(OWNER_PREFIX.length) : name;
}

// Riscrive il nome quando cambia owner (transfer / claim). Esportato perché
// lo usano anche i comandi /voice transfer e /voice claim.
async function renameForNewOwner(channel, newOwnerMember) {
  if (!channel || !newOwnerMember) return;
  try {
    await channel.setName(formatOwnerName(newOwnerMember.user.username), 'owner changed');
  } catch (err) {
    logger.warn({ err: err.message, channel: channel.id, newOwner: newOwnerMember.id }, 'rinomina owner fallita');
  }
}

async function scheduleEmptyDelete(state) {
  const temp = await repo.getTempChannel(state.channelId);
  if (!temp || temp.kind !== 'voice') return;

  const channel = state.guild.channels.cache.get(state.channelId);
  if (!channel) return;

  if (channel.members.size > 0) {
    cancelPendingDelete(state.channelId);
    return;
  }

  if (pendingDeletes.has(state.channelId)) return;

  const seconds = await settingsResolver.getSetting(state.guild.id, 'autoDeleteSecondsEmpty', config.features.tempChannels.autoDeleteSecondsEmpty);
  const handle = setTimeout(async () => {
    pendingDeletes.delete(state.channelId);
    try {
      const fresh = state.guild.channels.cache.get(state.channelId);
      if (!fresh || fresh.members.size > 0) return;

      // PRIMA di eliminare la riga TempChannel, salviamo uno snapshot persistente
      // su VoiceRoom. Se lo stesso owner (o uno nuovo che fa claim/transfer)
      // rientrerà nello stesso hub, ritroverà locked + blocked + eventuali
      // impostazioni extra.
      const temp = await repo.getTempChannel(state.channelId);
      if (temp && temp.owner_id) {
        const hubId = temp.hub_channel_id || voiceTracker.getHubChannelId(state.guild.id, state.channelId);
        if (hubId) {
          await repo.saveVoiceRoom(state.guild.id, temp.owner_id, hubId, {
            locked: temp.locked || 0,
            blocked: Array.isArray(temp.blocked) ? temp.blocked : [],
            settings: JSON.stringify({
              userLimit: fresh.userLimit ?? 0,
              name: fresh.name,
            }),
          }).catch((err) => logger.warn({ err: err.message, channel: state.channelId }, 'snapshot VoiceRoom fallito'));
          logger.info({ channel: state.channelId, owner: temp.owner_id, hub: hubId }, 'snapshot VoiceRoom salvato');
        }
      }

      await repo.removeTempChannel(state.channelId);
      voiceTracker.remove(state.guild.id, state.channelId);
      await fresh.delete('canale temporaneo vuoto');
      logger.info({ channel: state.channelId }, 'canale vocale temporaneo eliminato');
    } catch (err) {
      logger.error({ err }, 'eliminazione canale temporaneo fallita');
    }
  }, seconds * 1000);

  pendingDeletes.set(state.channelId, handle);
}

function cancelPendingDelete(channelId) {
  const handle = pendingDeletes.get(channelId);
  if (handle) {
    clearTimeout(handle);
    pendingDeletes.delete(channelId);
  }
}

