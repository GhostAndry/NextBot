'use strict';

// Poker table game logic, separated from the slash command and the DB layer.
//
// The state machine:
//   lobby   -> players create/join/leave, then start
//   preflop -> blinds posted, 2 hole cards each, betting round
//   flop    -> 3 community cards revealed, betting round
//   turn    -> 1 more community card, betting round
//   river   -> 1 more community card, betting round
//   showdown -> remaining players compare hands
//
// All functions are async (Prisma is async-only).

const { newDeck, popCard, bestHandOf7 } = require('./poker-cards');
const repo = require('../db/repo');

const STAGES = ['lobby', 'preflop', 'flop', 'turn', 'river', 'showdown'];

function nextStageAfter(stage) {
  const order = ['preflop', 'flop', 'turn', 'river'];
  const i = order.indexOf(stage);
  if (i === -1 || i === order.length - 1) return 'showdown';
  return order[i + 1];
}

async function createTable(guildId, channelId, hostId, smallBlind) {
  const id = generateTableId();
  await repo.createPokerTable(id, guildId, channelId, hostId, smallBlind);
  return id;
}

async function getTable(channelId) {
  return repo.getPokerTableByChannel(channelId);
}

async function endTable(tableId) {
  await refundAllPlayers(tableId);
  await repo.deletePokerTable(tableId);
}

async function refundAllPlayers(tableId) {
  const players = await repo.listPokerPlayers(tableId);
  const guildId = await repo.getPokerTableGuildId(tableId);

  for (const p of players) {
    const u = await repo.getUser(p.user_id, guildId);
    await repo.updateUser(p.user_id, guildId, { wallet: u.wallet + p.chips });
    await repo.deletePokerPlayer(tableId, p.user_id);
  }
}

async function joinTable(tableId, userId, buyInAmount) {
  await repo.upsertPokerPlayer({
    table_id: tableId,
    user_id: userId,
    chips: buyInAmount,
    bet: 0,
    folded: 0,
    all_in: 0,
    hand: null,
    position: await countPlayers(tableId),
  });
}

async function leaveTable(tableId, userId) {
  const p = await repo.getPokerPlayer(tableId, userId);
  if (!p) return null;
  await repo.deletePokerPlayer(tableId, userId);
  return p;
}

async function countPlayers(tableId) {
  const players = await repo.listPokerPlayers(tableId);
  return players.length;
}

async function listPlayers(tableId) {
  return repo.listPokerPlayers(tableId);
}

// Ricarica lo stato corrente del tavolo dal DB. Da usare nelle action()
// per evitare di operare su uno state stale se due azioni arrivano vicine.
// NB: lo state è JSON dentro la colonna `state` della riga PokerTable.
async function reloadTable(table) {
  const fresh = await repo.getPokerTable(table.id);
  if (!fresh) return table;
  let parsed;
  try { parsed = JSON.parse(fresh.state); } catch (_) { parsed = table.state; }
  return { ...fresh, state: parsed };
}

async function startHand(table) {
  const deck = newDeck();
  const basePlayers = await listPlayers(table.id);
  const players = basePlayers.map((p) => ({
    ...p,
    hand: [popCard(deck), popCard(deck)],
    bet: 0,
    folded: 0,
    all_in: 0,
  }));

  for (const p of players) await repo.upsertPokerPlayer(p);

  // Post blinds: players[0] = SB, players[1] = BB.
  const sbPlayer = players[0];
  const bbPlayer = players[1];
  sbPlayer.chips -= table.small_blind;
  sbPlayer.bet = table.small_blind;
  bbPlayer.chips -= table.small_blind;
  bbPlayer.bet = table.small_blind;
  await repo.upsertPokerPlayer(sbPlayer);
  await repo.upsertPokerPlayer(bbPlayer);

  const state = {
    stage: 'preflop',
    deck,
    community: [],
    turnIdx: 2 % players.length,
    lastAggressor: 1,
    lastBet: table.small_blind,
  };

  const pot = table.small_blind * 2;
  await repo.updatePokerTable(table.id, state, pot);
  return { state, pot, players };
}

async function call(table, userId) {
  table = await reloadTable(table);
  const players = await listPlayers(table.id);
  const idx = players.findIndex((p) => p.user_id === userId);
  if (idx === -1) return { error: 'not_in_table' };
  if (idx !== table.state.turnIdx) return { error: 'not_your_turn' };

  const p = players[idx];
  if (p.folded || p.all_in) return { error: 'cannot_act' };

  const toCall = table.state.lastBet - p.bet;
  const pay = Math.min(toCall, p.chips);
  p.chips -= pay;
  p.bet += pay;
  if (p.chips === 0) p.all_in = 1;

  await repo.upsertPokerPlayer(p);
  await repo.updatePokerTable(table.id, table.state, table.pot + pay);

  return { table: { ...table, pot: table.pot + pay, players }, player: p };
}

async function raise(table, userId, raiseAmount) {
  table = await reloadTable(table);
  const players = await listPlayers(table.id);
  const idx = players.findIndex((p) => p.user_id === userId);
  if (idx === -1) return { error: 'not_in_table' };
  if (idx !== table.state.turnIdx) return { error: 'not_your_turn' };

  const p = players[idx];
  if (p.folded || p.all_in) return { error: 'cannot_act' };

  const toCall = table.state.lastBet - p.bet;
  if (raiseAmount < toCall + 1) return { error: 'min_raise', minRaise: toCall + 1 };
  if (p.chips < toCall + raiseAmount) return { error: 'not_enough' };

  p.chips -= toCall + raiseAmount;
  p.bet += toCall + raiseAmount;
  if (p.chips === 0) p.all_in = 1;

  table.state.lastBet = p.bet;
  table.state.lastAggressor = idx;

  await repo.upsertPokerPlayer(p);
  await repo.updatePokerTable(table.id, table.state, table.pot + toCall + raiseAmount);

  return { table: { ...table, pot: table.pot + toCall + raiseAmount, players }, player: p };
}

async function fold(table, userId) {
  table = await reloadTable(table);
  const players = await listPlayers(table.id);
  const idx = players.findIndex((p) => p.user_id === userId);
  if (idx === -1) return { error: 'not_in_table' };
  if (idx !== table.state.turnIdx) return { error: 'not_your_turn' };

  const p = players[idx];
  p.folded = 1;
  await repo.upsertPokerPlayer(p);

  return { table: { ...table, players }, player: p };
}

async function check(table, userId) {
  if (table.state.lastBet > 0) return { error: 'cannot_check' };
  table = await reloadTable(table);
  const players = await listPlayers(table.id);
  const idx = players.findIndex((p) => p.user_id === userId);
  if (idx === -1) return { error: 'not_in_table' };
  if (idx !== table.state.turnIdx) return { error: 'not_your_turn' };

  return { table, player: players[idx] };
}

async function advanceTurn(table) {
  const players = await listPlayers(table.id);
  table.state.turnIdx = (table.state.turnIdx + 1) % players.length;
  await repo.updatePokerTable(table.id, table.state, table.pot);
  return { table: { ...table, players } };
}

async function isBettingClosed(table) {
  const players = await listPlayers(table.id);
  const active = players.filter((p) => !p.folded && !p.all_in);

  if (active.length <= 1) return true;

  let startIdx = table.state.lastAggressor === -1 ? 0 : (table.state.lastAggressor + 1) % players.length;
  for (let i = 0, k = startIdx; i < players.length; i++, k = (k + 1) % players.length) {
    const p = players[k];
    if (p.folded || p.all_in) continue;
    if (p.bet !== table.state.lastBet) return false;
  }
  return true;
}

async function dealNextStreet(table) {
  const state = table.state;

  if (state.stage === 'preflop') {
    state.community.push(popCard(state.deck), popCard(state.deck), popCard(state.deck));
  } else if (state.stage === 'flop' || state.stage === 'turn') {
    state.community.push(popCard(state.deck));
  }

  state.stage = nextStageAfter(state.stage);

  const players = await listPlayers(table.id);
  for (const p of players) {
    p.bet = 0;
    await repo.upsertPokerPlayer(p);
  }
  state.lastBet = 0;
  state.lastAggressor = -1;

  const fresh = await listPlayers(table.id);
  let next = (state.turnIdx + 1) % fresh.length;
  while (fresh[next].folded) next = (next + 1) % fresh.length;
  state.turnIdx = next;

  await repo.updatePokerTable(table.id, state, table.pot);

  return { stage: state.stage, community: state.community };
}

async function showdown(table, guildId) {
  const players = await listPlayers(table.id);
  const live = players.filter((p) => !p.folded);
  if (live.length === 0) return { winner: null, pot: 0 };

  const evaluated = live.map((p) => ({
    player: p,
    hand: bestHandOf7([...p.hand, ...table.state.community]),
  }));
  evaluated.sort((a, b) => b.hand.score - a.hand.score);

  const winner = evaluated[0].player;
  const winnerUser = await repo.getUser(winner.user_id, guildId);
  await repo.updateUser(winner.user_id, guildId, { wallet: winnerUser.wallet + table.pot });
  winner.chips += table.pot;
  await repo.upsertPokerPlayer(winner);

  const pot = table.pot;
  table.pot = 0;
  table.state.stage = 'lobby';
  table.state.deck = null;
  table.state.community = [];

  for (const p of players) {
    p.bet = 0;
    p.folded = 0;
    p.all_in = 0;
    p.hand = null;
    await repo.upsertPokerPlayer(p);
  }
  await repo.updatePokerTable(table.id, table.state, 0);

  return { winner, pot, potPaidOut: true, evaluated };
}

function generateTableId() {
  return require('crypto').randomBytes(6).toString('hex');
}

module.exports = {
  STAGES,
  createTable, getTable, endTable, joinTable, leaveTable, countPlayers, listPlayers,
  startHand, call, raise, fold, check, advanceTurn, isBettingClosed, dealNextStreet, showdown,
};
