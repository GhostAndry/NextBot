'use strict';

// Tutte le operazioni di lettura/scrittura vanno attraverso Prisma.
// L'applicazione non scrive mai query direttamente: passa da qui.
//
// Il layer restituisce righe con campi snake_case (come prima) così il resto
// del codice di dominio non deve cambiare i nomi dei campi, ma solo aggiungere
// `await` alle chiamate. Prisma espone campi camelCase; li convertiamo qui.

const prisma = require('./prisma');

// --- Tempo ------------------------------------------------------------------

const now = () => Math.floor(Date.now() / 1000);

// --- Conversione campi ------------------------------------------------------

function toSnakeCase(str) {
  return str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function toCamelCase(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// Converte una riga Prisma (camelCase) in snake_case.
function toSnake(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[toSnakeCase(k)] = v;
  return out;
}

function mapRows(rows) {
  return rows.map(toSnake);
}

// Converte un oggetto di campi snake_case in camelCase per Prisma.
function toCamelFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[toCamelCase(k)] = v;
  return out;
}

// --- Utenti e livelli --------------------------------------------------------

async function ensureUser(userId, guildId) {
  return prisma.user.upsert({
    where: { userId_guildId: { userId, guildId } },
    create: { userId, guildId },
    update: {},
  });
}

async function getUser(userId, guildId) {
  await ensureUser(userId, guildId);
  const row = await prisma.user.findUnique({
    where: { userId_guildId: { userId, guildId } },
  });
  return toSnake(row);
}

async function updateUser(userId, guildId, fields) {
  if (!fields || Object.keys(fields).length === 0) return;

  await ensureUser(userId, guildId);
  await prisma.user.update({
    where: { userId_guildId: { userId, guildId } },
    data: toCamelFields(fields),
  });
}

// --- Economia ----------------------------------------------------------------

async function addWallet(userId, guildId, amount) {
  await ensureUser(userId, guildId);
  await prisma.user.update({
    where: { userId_guildId: { userId, guildId } },
    data: { wallet: { increment: amount } },
  });
}

// Claim atomico del daily: aggiorna lastDaily SOLO se è scaduto. Ritorna
// il numero di righe aggiornate: 0 = cooldown ancora attivo, 1 = claim OK.
// Usato da cmdDaily per evitare la race condition classica (read-then-write).
async function claimDailyIfElapsed(userId, guildId, now, cooldownSeconds, fields) {
  await ensureUser(userId, guildId);
  const minElapsedAt = now - cooldownSeconds;
  const updated = await prisma.user.updateMany({
    where: {
      userId_guildId: { userId, guildId },
      OR: [
        { lastDaily: 0 },
        { lastDaily: { lt: minElapsedAt } },
      ],
    },
    data: { ...fields, lastDaily: now },
  });
  return updated.count > 0;
}

// Come claimDailyIfElapsed, per work.
async function claimWorkIfElapsed(userId, guildId, now, cooldownSeconds, fields) {
  await ensureUser(userId, guildId);
  const minElapsedAt = now - cooldownSeconds;
  const updated = await prisma.user.updateMany({
    where: {
      userId_guildId: { userId, guildId },
      OR: [
        { lastWork: 0 },
        { lastWork: { lt: minElapsedAt } },
      ],
    },
    data: { ...fields, lastWork: now },
  });
  return updated.count > 0;
}

async function transfer(fromId, toId, guildId, amount) {
  await ensureUser(fromId, guildId);
  await ensureUser(toId, guildId);

  return prisma.$transaction(async (tx) => {
    const sender = await tx.user.findUnique({
      where: { userId_guildId: { userId: fromId, guildId } },
    });
    if (!sender || sender.wallet < amount) return false;

    await tx.user.update({
      where: { userId_guildId: { userId: fromId, guildId } },
      data: { wallet: { decrement: amount } },
    });
    await tx.user.update({
      where: { userId_guildId: { userId: toId, guildId } },
      data: { wallet: { increment: amount } },
    });
    return true;
  });
}

// XP e livelli: soglie su curva quadratica, i primi livelli sono rapidi.
function xpForLevel(level) {
  return 5 * level * level + 50 * level + 100;
}

function levelForXp(xp) {
  let level = 0;
  while (xp >= xpForLevel(level + 1)) level += 1;
  return level;
}

async function addXp(userId, guildId, xp) {
  await ensureUser(userId, guildId);
  await prisma.user.update({
    where: { userId_guildId: { userId, guildId } },
    data: {
      xp: { increment: xp },
      totalMessages: { increment: 1 },
      lastXpAt: now(),
    },
  });

  const user = await getUser(userId, guildId);
  return levelForXp(user.xp);
}

async function topXp(guildId, limit = 10) {
  const rows = await prisma.user.findMany({
    where: { guildId },
    orderBy: { xp: 'desc' },
    take: limit,
    select: { userId: true, xp: true, level: true },
  });
  return mapRows(rows);
}

async function topWallet(guildId, limit = 10) {
  const rows = await prisma.user.findMany({
    where: { guildId },
    orderBy: { wallet: 'desc' },
    take: limit,
    select: { userId: true, wallet: true, bank: true },
  });
  // Ordina per totale wallet+bank dopo il fetch (SQLite non ha + in orderBy semplice).
  rows.sort((a, b) => (b.wallet + b.bank) - (a.wallet + a.bank));
  return mapRows(rows.slice(0, limit));
}

// --- Moderazione -------------------------------------------------------------

async function addWarn(guildId, userId, modId, reason) {
  return prisma.warn.create({
    data: { guildId, userId, moderatorId: modId, reason: reason || null, createdAt: now() },
  });
}

async function getWarns(guildId, userId) {
  const rows = await prisma.warn.findMany({
    where: { guildId, userId },
    orderBy: { id: 'desc' },
  });
  return mapRows(rows);
}

async function countWarns(guildId, userId) {
  return prisma.warn.count({ where: { guildId, userId } });
}

async function clearWarns(guildId, userId) {
  return prisma.warn.deleteMany({ where: { guildId, userId } });
}

async function addModLog(guildId, action, targetId, modId, reason, durationMs) {
  return prisma.modLog.create({
    data: {
      guildId,
      action,
      targetId,
      moderatorId: modId,
      reason: reason || null,
      durationMs: durationMs || null,
      createdAt: now(),
    },
  });
}

// --- Ticket ------------------------------------------------------------------

async function createTicket(guildId, channelId, userId) {
  return prisma.ticket.create({
    data: { guildId, channelId, userId, createdAt: now() },
  });
}

async function getOpenTicketByUser(guildId, userId) {
  const row = await prisma.ticket.findFirst({
    where: { guildId, userId, closed: 0 },
    orderBy: { id: 'desc' },
  });
  return toSnake(row);
}

async function countOpenTickets(guildId) {
  return prisma.ticket.count({ where: { guildId, closed: 0 } });
}

async function getOpenTicketByChannel(channelId) {
  const row = await prisma.ticket.findFirst({
    where: { channelId, closed: 0 },
  });
  return toSnake(row);
}

async function getTicketByChannel(channelId) {
  const row = await prisma.ticket.findFirst({
    where: { channelId },
    orderBy: { id: 'desc' },
  });
  return toSnake(row);
}

async function claimTicket(channelId, modId) {
  return prisma.ticket.updateMany({
    where: { channelId, closed: 0 },
    data: { claimedBy: modId },
  });
}

async function closeTicket(channelId) {
  return prisma.ticket.updateMany({
    where: { channelId, closed: 0 },
    data: { closed: 1, closedAt: now() },
  });
}

// --- Hub vocali (multi-hub temp voice) --------------------------------------

async function addVoiceHub(guildId, channelId, name, parentId) {
  // Il primo hub diventa automaticamente default.
  const existing = await prisma.voiceHub.count({ where: { guildId } });
  return prisma.voiceHub.create({
    data: {
      guildId,
      channelId,
      name: name || 'Hub',
      parentId: parentId || null,
      isDefault: existing === 0 ? 1 : 0,
      createdAt: now(),
    },
  });
}

async function removeVoiceHub(channelId) {
  return prisma.voiceHub.deleteMany({ where: { channelId } });
}

async function removeVoiceHubById(id) {
  return prisma.voiceHub.delete({ where: { id } });
}

async function getVoiceHubByChannel(channelId) {
  const row = await prisma.voiceHub.findUnique({ where: { channelId } });
  return row ? toSnake(row) : null;
}

async function getVoiceHubById(id) {
  const row = await prisma.voiceHub.findUnique({ where: { id } });
  return row ? toSnake(row) : null;
}

async function listVoiceHubs(guildId) {
  const rows = await prisma.voiceHub.findMany({
    where: { guildId },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  });
  return mapRows(rows);
}

async function setDefaultVoiceHub(channelId) {
  // Resetta tutti gli altri, poi imposta questo come default.
  const target = await prisma.voiceHub.findUnique({ where: { channelId } });
  if (!target) return null;
  await prisma.voiceHub.updateMany({
    where: { guildId: target.guildId },
    data: { isDefault: 0 },
  });
  await prisma.voiceHub.update({
    where: { channelId },
    data: { isDefault: 1 },
  });
  return toSnake(target);
}

async function renameVoiceHub(channelId, name) {
  return prisma.voiceHub.update({
    where: { channelId },
    data: { name },
  });
}

// Lista di tutti gli hub di un guild, indicizzati per channelId. Usata
// dall'evento voiceStateUpdate per sapere se l'ingresso è in un hub e dove
// generare il temp channel.
async function getHubChannelIds(guildId) {
  const rows = await prisma.voiceHub.findMany({
    where: { guildId },
    select: { channelId: true },
  });
  return rows.map((r) => r.channelId);
}

// --- Canali temporanei -------------------------------------------------------

async function openTempChannel(channelId, guildId, ownerId, kind, hubChannelId = null) {
  return prisma.tempChannel.create({
    data: { channelId, guildId, ownerId, kind, hubChannelId, createdAt: now() },
  });
}

// --- Snapshot persistente delle impostazioni temp voice (VoiceRoom) --------

// Sopravvive alla cancellazione del canale. Quando (guild, owner, hub) già
// esiste in VoiceRoom, viene sovrascritto (upsert) con i valori correnti del
// canale live, in modo che al prossimo rientro l'utente ritrovi le stesse
// impostazioni.
//
// Le impostazioni sono: locked, blocked, settings JSON extra (name, userLimit, etc).

async function saveVoiceRoom(guildId, ownerId, hubChannelId, fields) {
  // Normalizza i campi che sul DB sono String ma a livello applicativo
  // passiamo come Array/Object.
  const normalized = { ...fields };
  if (Array.isArray(normalized.blocked)) normalized.blocked = JSON.stringify(normalized.blocked);
  if (Array.isArray(normalized.banned)) normalized.banned = JSON.stringify(normalized.banned);
  if (normalized.settings && typeof normalized.settings !== 'string') {
    normalized.settings = JSON.stringify(normalized.settings);
  }

  if (!normalized || Object.keys(normalized).length === 0) {
    // Touch lastActiveAt senza toccare il resto.
    return prisma.voiceRoom.upsert({
      where: { guildId_ownerId_hubChannelId: { guildId, ownerId, hubChannelId } },
      create: { guildId, ownerId, hubChannelId, lastActiveAt: now() },
      update: { lastActiveAt: now() },
    });
  }

  const data = toCamelFields(normalized);
  data.lastActiveAt = now();
  return prisma.voiceRoom.upsert({
    where: { guildId_ownerId_hubChannelId: { guildId, ownerId, hubChannelId } },
    create: { guildId, ownerId, hubChannelId, ...data },
    update: data,
  });
}

async function getVoiceRoom(guildId, ownerId, hubChannelId) {
  const row = await prisma.voiceRoom.findUnique({
    where: { guildId_ownerId_hubChannelId: { guildId, ownerId, hubChannelId } },
  });
  if (!row) return null;
  return withBlockedList(toSnake(row));
}

async function listVoiceRoomsByHub(guildId, hubChannelId) {
  const rows = await prisma.voiceRoom.findMany({ where: { guildId, hubChannelId } });
  return rows.map((r) => withBlockedList(toSnake(r)));
}

async function deleteVoiceRoom(guildId, ownerId, hubChannelId) {
  return prisma.voiceRoom.deleteMany({
    where: { guildId, ownerId, hubChannelId },
  });
}

async function removeTempChannel(channelId) {
  return prisma.tempChannel.deleteMany({ where: { channelId } });
}

async function getTempChannel(channelId) {
  const row = await prisma.tempChannel.findUnique({ where: { channelId } });
  return withBlockedList(toSnake(row));
}

function parseBlockedList(blob) {
  if (!blob) return [];
  try {
    const parsed = JSON.parse(blob);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function parseBannedList(blob) {
  if (!blob) return [];
  try {
    const parsed = JSON.parse(blob);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function withBlockedList(row) {
  if (!row) return row;
  const blocked = parseBlockedList(row.blocked);
  const banned = parseBannedList(row.banned);
  const settings = parseSettingsField(row.settings);
  return { ...row, blocked, banned, settings };
}

function parseSettingsField(blob) {
  if (!blob) return {};
  if (typeof blob === 'object') return blob;
  try {
    const parsed = JSON.parse(blob);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

async function getTempChannelsByOwner(guildId, ownerId) {
  const rows = await prisma.tempChannel.findMany({ where: { guildId, ownerId } });
  return rows.map(withBlockedList).map(toSnake);
}

async function listAllTempChannelsForGuild(guildId) {
  const rows = await prisma.tempChannel.findMany({ where: { guildId } });
  return rows.map(withBlockedList).map(toSnake);
}

async function transferTempOwnership(channelId, newOwnerId) {
  return prisma.tempChannel.update({
    where: { channelId },
    data: { ownerId: newOwnerId },
  });
}

async function setTempLocked(channelId, locked) {
  return prisma.tempChannel.update({
    where: { channelId },
    data: { locked: locked ? 1 : 0 },
  });
}

async function addBlockedUser(channelId, userId) {
  const row = await prisma.tempChannel.findUnique({ where: { channelId } });
  if (!row) return [];
  const list = parseBlockedList(row.blocked);
  if (!list.includes(userId)) list.push(userId);
  await prisma.tempChannel.update({
    where: { channelId },
    data: { blocked: JSON.stringify(list) },
  });
  return list;
}

async function removeBlockedUser(channelId, userId) {
  const row = await prisma.tempChannel.findUnique({ where: { channelId } });
  if (!row) return [];
  const list = parseBlockedList(row.blocked).filter((id) => id !== userId);
  await prisma.tempChannel.update({
    where: { channelId },
    data: { blocked: JSON.stringify(list) },
  });
  return list;
}

async function clearBlockedUsers(channelId) {
  await prisma.tempChannel.update({
    where: { channelId },
    data: { blocked: '[]' },
  });
  return [];
}

// --- Ban / Unban utenti dal canale vocale --------------------------------
//
// Il "ban" del canale vocale è diverso dal kick: il ban applica un
// permission overwrite `Connect: false` sul canale per quell'utente, lo espelle
// se è dentro, e persiste in DB (TempChannel + snapshot VoiceRoom) anche dopo
// la cancellazione del canale. L'unban rimuove sia l'overwrite sia l'entry
// dalla lista banned.

async function banVoiceUser(channelId, userId) {
  const row = await prisma.tempChannel.findUnique({ where: { channelId } });
  if (!row) return [];
  const list = parseBannedList(row.banned);
  if (!list.includes(userId)) list.push(userId);
  await prisma.tempChannel.update({
    where: { channelId },
    data: { banned: JSON.stringify(list) },
  });
  return list;
}

async function unbanVoiceUser(channelId, userId) {
  const row = await prisma.tempChannel.findUnique({ where: { channelId } });
  if (!row) return [];
  const list = parseBannedList(row.banned).filter((id) => id !== userId);
  await prisma.tempChannel.update({
    where: { channelId },
    data: { banned: JSON.stringify(list) },
  });
  return list;
}

async function clearBannedUsers(channelId) {
  await prisma.tempChannel.update({
    where: { channelId },
    data: { banned: '[]' },
  });
  return [];
}

// --- Soundboard --------------------------------------------------------------

async function createSoundboard(guildId, userId, name, filePath, fileSize) {
  return prisma.soundboard.create({
    data: {
      guildId, userId, name,
      nameLower: name.toLowerCase(),
      filePath, fileSize, createdAt: now(),
    },
  });
}

// Le ricerche soundboard usano `nameLower` (campo denormalizzato) invece di
// `mode: 'insensitive'`, che Prisma supporta solo su postgres/mysql/mongodb.
// Questo rende il lookup portabile tra sqlite e postgres.

async function getSoundboard(guildId, name) {
  const row = await prisma.soundboard.findFirst({
    where: { guildId, nameLower: name.toLowerCase() },
  });
  return toSnake(row);
}

async function listSoundboards(guildId, limit = 25) {
  const rows = await prisma.soundboard.findMany({
    where: { guildId },
    orderBy: [{ plays: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  });
  return mapRows(rows);
}

async function searchSoundboards(guildId, prefix, limit = 25) {
  // SQLite non supporta `mode: 'insensitive'`, filtriamo in memoria sul campo
  // denormalizzato `nameLower`. Buona approssimazione: l'utente digita in
  // lowercase (l'app normalizza i nomi in fase di salvataggio).
  const needle = (prefix || '').toLowerCase();
  const all = await prisma.soundboard.findMany({
    where: { guildId },
    orderBy: [{ plays: 'desc' }, { createdAt: 'desc' }],
    take: 200,
  });
  return mapRows(all)
    .filter((r) => r.name.toLowerCase().startsWith(needle))
    .slice(0, limit);
}

async function deleteSoundboard(guildId, name) {
  return prisma.soundboard.deleteMany({
    where: { guildId, nameLower: name.toLowerCase() },
  });
}

async function incrementSoundboardPlays(guildId, name) {
  return prisma.soundboard.updateMany({
    where: { guildId, nameLower: name.toLowerCase() },
    data: { plays: { increment: 1 } },
  });
}

async function renameSoundboard(guildId, oldName, newName) {
  return prisma.soundboard.updateMany({
    where: { guildId, nameLower: oldName.toLowerCase() },
    data: { name: newName, nameLower: newName.toLowerCase() },
  });
}

// --- Sessioni di gioco -------------------------------------------------------

async function saveGameSession(id, guildId, channelId, userId, game, state) {
  return prisma.gameSession.upsert({
    where: { id },
    create: {
      id, guildId, channelId, userId, game,
      state: JSON.stringify(state), createdAt: now(), updatedAt: now(),
    },
    update: { state: JSON.stringify(state), updatedAt: now() },
  });
}

async function getGameSession(id) {
  const row = await prisma.gameSession.findUnique({ where: { id } });
  if (!row) return null;
  const out = toSnake(row);
  try { out.state = JSON.parse(out.state); } catch (_) { out.state = {}; }
  return out;
}

async function deleteGameSession(id) {
  return prisma.gameSession.deleteMany({ where: { id } });
}

// --- Blackjack ---------------------------------------------------------------

async function saveBlackjackSession(userId, guildId, session) {
  return prisma.blackjackSession.upsert({
    where: { userId_guildId: { userId, guildId } },
    create: {
      userId, guildId,
      deck: JSON.stringify(session.deck),
      playerHand: JSON.stringify(session.player),
      dealerHand: JSON.stringify(session.dealer),
      bet: session.bet,
      status: session.status,
      updatedAt: now(),
    },
    update: {
      deck: JSON.stringify(session.deck),
      playerHand: JSON.stringify(session.player),
      dealerHand: JSON.stringify(session.dealer),
      bet: session.bet,
      status: session.status,
      updatedAt: now(),
    },
  });
}

async function getBlackjackSession(userId, guildId) {
  const row = await prisma.blackjackSession.findUnique({
    where: { userId_guildId: { userId, guildId } },
  });
  if (!row) return null;

  return {
    deck: JSON.parse(row.deck),
    player: JSON.parse(row.playerHand),
    dealer: JSON.parse(row.dealerHand),
    bet: row.bet,
    status: row.status,
  };
}

async function deleteBlackjackSession(userId, guildId) {
  return prisma.blackjackSession.deleteMany({
    where: { userId_guildId: { userId, guildId } },
  });
}

// --- Poker -------------------------------------------------------------------

async function createPokerTable(id, guildId, channelId, hostId, smallBlind) {
  return prisma.pokerTable.create({
    data: {
      id, guildId, channelId, hostId,
      state: JSON.stringify(initialPokerState()),
      smallBlind,
      createdAt: now(),
      updatedAt: now(),
    },
  });
}

async function getPokerTable(tableId) {
  const row = await prisma.pokerTable.findUnique({ where: { id: tableId } });
  if (!row) return null;
  return toSnake(row);
}

async function getPokerTableByChannel(channelId) {
  const row = await prisma.pokerTable.findFirst({
    where: { channelId },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return null;

  const t = toSnake(row);
  try { t.state = JSON.parse(t.state); } catch (_) { t.state = {}; }
  t.players = await listPokerPlayers(t.id);
  return t;
}

async function getPokerTableGuildId(tableId) {
  const row = await prisma.pokerTable.findUnique({ where: { id: tableId } });
  return row?.guildId;
}

async function updatePokerTable(tableId, state, pot) {
  return prisma.pokerTable.update({
    where: { id: tableId },
    data: { state: JSON.stringify(state), pot, updatedAt: now() },
  });
}

async function deletePokerTable(tableId) {
  return prisma.pokerTable.deleteMany({ where: { id: tableId } });
}

async function getPokerPlayer(tableId, userId) {
  const row = await prisma.pokerPlayer.findUnique({
    where: { tableId_userId: { tableId, userId } },
  });
  const out = toSnake(row);
  if (out?.hand) { try { out.hand = JSON.parse(out.hand); } catch (_) {} }
  return out;
}

async function upsertPokerPlayer(p) {
  const hand = p.hand ? JSON.stringify(p.hand) : null;
  return prisma.pokerPlayer.upsert({
    where: { tableId_userId: { tableId: p.table_id, userId: p.user_id } },
    create: {
      tableId: p.table_id,
      userId: p.user_id,
      chips: p.chips,
      bet: p.bet,
      folded: p.folded,
      allIn: p.all_in,
      hand,
      position: p.position,
    },
    update: {
      chips: p.chips,
      bet: p.bet,
      folded: p.folded,
      allIn: p.all_in,
      hand,
      position: p.position,
    },
  });
}

async function deletePokerPlayer(tableId, userId) {
  return prisma.pokerPlayer.deleteMany({
    where: { tableId, userId },
  });
}

async function listPokerPlayers(tableId) {
  const rows = await prisma.pokerPlayer.findMany({
    where: { tableId },
    orderBy: { position: 'asc' },
  });
  return mapRows(rows).map((p) => {
    if (p.hand) { try { p.hand = JSON.parse(p.hand); } catch (_) {} }
    return p;
  });
}

function initialPokerState() {
  return { stage: 'lobby', deck: null, community: [], turnIdx: 0, lastAggressor: -1, lastBet: 0 };
}

// --- Configurazione guild -----------------------------------------------------

async function getGuildConfig(guildId) {
  let row = await prisma.guildConfig.findUnique({ where: { guildId } });

  if (!row) {
    row = await prisma.guildConfig.create({ data: { guildId, createdAt: now() } });
  }

  return toSnake(row);
}

async function setGuildConfig(guildId, fields) {
  if (!fields || Object.keys(fields).length === 0) return;

  await getGuildConfig(guildId);
  await prisma.guildConfig.update({
    where: { guildId },
    data: toCamelFields(fields),
  });
}

// `settings` è un blob JSON per i tunables per-guild. Restituisce sempre
// un oggetto (mai null) e fa fallback silenzioso su {} quando il blob è vuoto
// o corrotto. Le letture successive usano `getGuildSetting(guildId, key, fallback)`
// così i call-site restano leggibili.

function parseSettingsBlob(blob) {
  if (!blob) return {};
  try {
    const parsed = JSON.parse(blob);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

async function getGuildSettings(guildId) {
  const cfg = await getGuildConfig(guildId);
  return parseSettingsBlob(cfg.settings);
}

async function getGuildSetting(guildId, key, fallback) {
  const all = await getGuildSettings(guildId);
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : fallback;
}

async function setGuildSetting(guildId, key, value) {
  const all = await getGuildSettings(guildId);
  all[key] = value;
  await setGuildConfig(guildId, { settings: JSON.stringify(all) });
  return value;
}

async function deleteGuildSetting(guildId, key) {
  const all = await getGuildSettings(guildId);
  if (!(key in all)) return false;
  delete all[key];
  await setGuildConfig(guildId, { settings: JSON.stringify(all) });
  return true;
}

module.exports = {
  prisma,
  now,
  ensureUser, getUser, updateUser,
  addWallet, transfer, claimDailyIfElapsed, claimWorkIfElapsed,
  xpForLevel, levelForXp, addXp, topXp, topWallet,
  addWarn, getWarns, countWarns, clearWarns, addModLog,
  createTicket, getOpenTicketByUser, getOpenTicketByChannel, getTicketByChannel, claimTicket, closeTicket, countOpenTickets,
  openTempChannel, removeTempChannel, getTempChannel,
  getTempChannelsByOwner, listAllTempChannelsForGuild, transferTempOwnership,
  setTempLocked, addBlockedUser, removeBlockedUser, clearBlockedUsers,
  banVoiceUser, unbanVoiceUser, clearBannedUsers,
  saveVoiceRoom, getVoiceRoom, listVoiceRoomsByHub, deleteVoiceRoom,
  addVoiceHub, removeVoiceHub, removeVoiceHubById, getVoiceHubByChannel,
  getVoiceHubById, listVoiceHubs, setDefaultVoiceHub, renameVoiceHub, getHubChannelIds,
  createSoundboard, getSoundboard, listSoundboards, searchSoundboards, deleteSoundboard, incrementSoundboardPlays, renameSoundboard,
  saveGameSession, getGameSession, deleteGameSession,
  saveBlackjackSession, getBlackjackSession, deleteBlackjackSession,
  createPokerTable, getPokerTable, getPokerTableByChannel, updatePokerTable, deletePokerTable,
  getPokerPlayer, upsertPokerPlayer, deletePokerPlayer, listPokerPlayers, getPokerTableGuildId,
  getGuildConfig, setGuildConfig,
  getGuildSettings, getGuildSetting, setGuildSetting, deleteGuildSetting,
};
