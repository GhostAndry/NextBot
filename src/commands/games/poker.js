'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const repo = require('../../db/repo');
const { errorEmbed, successEmbed } = require('../../utils/helpers');
const poker = require('../../services/poker-game');
const { cardString } = require('../../services/poker-cards');

const BUY_IN_MIN = 50;
const BUY_IN_MAX = 100_000;

const STAGE_LABELS = {
  lobby: 'Lobby',
  preflop: 'Preflop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
  showdown: 'Showdown',
};

// --- Definizione comando ---------------------------------------------------

const data = new SlashCommandBuilder()
  .setName('poker')
  .setDescription('Texas Hold\'em (multigiocatore)')
  .addSubcommand((sc) => sc.setName('create').setDescription('Crea un tavolo').addIntegerOption((o) => o.setName('buy_in').setDescription(`Importo buy-in (${BUY_IN_MIN}-${BUY_IN_MAX})`).setRequired(true).setMinValue(BUY_IN_MIN).setMaxValue(BUY_IN_MAX)))
  .addSubcommand((sc) => sc.setName('join').setDescription('Entra in un tavolo'))
  .addSubcommand((sc) => sc.setName('leave').setDescription('Esci dal tavolo attuale'))
  .addSubcommand((sc) => sc.setName('start').setDescription('Inizia la mano (solo host)'))
  .addSubcommand((sc) => sc.setName('call').setDescription('Vedi la puntata attuale'))
  .addSubcommand((sc) => sc.setName('raise').setDescription('Rilancia').addIntegerOption((o) => o.setName('importo').setDescription('Importo del rilancio').setRequired(true).setMinValue(1)))
  .addSubcommand((sc) => sc.setName('fold').setDescription('Passa la mano'))
  .addSubcommand((sc) => sc.setName('check').setDescription('Bussa (solo se nessuno ha rilanciato)'))
  .addSubcommand((sc) => sc.setName('status').setDescription('Mostra lo stato del tavolo'))
  .addSubcommand((sc) => sc.setName('end').setDescription('Chiudi il tavolo (solo host)'));

// --- Dispatcher -----------------------------------------------------------

async function execute(interaction) {
  if (!config.features.poker.enabled) {
    return replyDisabled(interaction);
  }

  const sub = interaction.options.getSubcommand();
  const handler = SUBCOMMAND_HANDLERS[sub];
  if (!handler) return replyError(interaction, 'Sottocomando sconosciuto.');
  return handler(interaction);
}

const SUBCOMMAND_HANDLERS = {
  create: createTable,
  join: joinTable,
  leave: leaveTable,
  start: startHand,
  call: act('call'),
  raise: act('raise'),
  fold: act('fold'),
  check: act('check'),
  status: showStatus,
  end: endTableCmd,
};

// --- Sottocomandi ---------------------------------------------------------

async function createTable(interaction) {
  const buyIn = interaction.options.getInteger('buy_in');
  if (!inBuyInRange(buyIn)) return replyError(interaction, `Il buy-in deve essere tra ${BUY_IN_MIN} e ${BUY_IN_MAX}.`);

  const existing = await poker.getTable(interaction.channelId);
  if (existing) return replyError(interaction, 'C\'è già un tavolo aperto in questo canale.');

  const user = await repo.getUser(interaction.user.id, interaction.guildId);
  if (user.wallet < buyIn) return replyError(interaction, `Il tuo portafoglio ha ${user.wallet}.`);

  const tableId = await poker.createTable(
    interaction.guildId,
    interaction.channelId,
    interaction.user.id,
    config.features.poker.smallBlind,
  );

  await repo.updateUser(interaction.user.id, interaction.guildId, { wallet: user.wallet - buyIn });
  await poker.joinTable(tableId, interaction.user.id, buyIn);

  await interaction.reply(embeds(successEmbed(
    'Tavolo creato',
    `Buy-in **${buyIn}**. I giocatori possono entrare con \`/poker join\`. Max ${config.features.poker.maxPlayers}.`,
  )));
}

async function joinTable(interaction) {
  const ctx = await requireOpenTableInChannel(interaction);
  if (!ctx) return;

  if (ctx.state.stage !== 'lobby') return replyError(interaction, 'Aspetta la prossima mano.');
  if ((await poker.listPlayers(ctx.id)).find((p) => p.user_id === interaction.user.id)) return replyError(interaction, 'Sei già al tavolo.');
  if (await poker.countPlayers(ctx.id) >= config.features.poker.maxPlayers) return replyError(interaction, `Massimo ${config.features.poker.maxPlayers} giocatori.`);

  const buyIn = await firstPlayerBuyIn(ctx.id) || config.features.poker.minBuyIn;
  const user = await repo.getUser(interaction.user.id, interaction.guildId);
  if (user.wallet < buyIn) return replyError(interaction, `Ti servono ${buyIn} per entrare.`);

  await repo.updateUser(interaction.user.id, interaction.guildId, { wallet: user.wallet - buyIn });
  await poker.joinTable(ctx.id, interaction.user.id, buyIn);

  await interaction.reply(embeds(successEmbed('Sei entrato', `Hai comprato **${buyIn}** gettoni.`)));
}

async function leaveTable(interaction) {
  const ctx = await requireOpenTableInChannel(interaction);
  if (!ctx) return;
  if (ctx.state.stage !== 'lobby') return replyError(interaction, 'Non puoi uscire a metà mano.');

  const player = (await poker.listPlayers(ctx.id)).find((p) => p.user_id === interaction.user.id);
  if (!player) return replyError(interaction, 'Non sei a questo tavolo.');

  const refund = await poker.leaveTable(ctx.id, interaction.user.id);
  if (refund == null) return replyError(interaction, 'Impossibile uscire.');

  await interaction.reply(embeds(successEmbed('Uscito', `Rimborsati **${refund}** gettoni.`)));
}

async function startHand(interaction) {
  const ctx = await requireOpenTableInChannel(interaction);
  if (!ctx) return;
  if (ctx.host_id !== interaction.user.id) return replyError(interaction, 'Solo l\'host può iniziare.');
  if (ctx.state.stage !== 'lobby') return replyError(interaction, 'La partita è già in corso.');

  const players = await poker.listPlayers(ctx.id);
  if (players.length < 2) return replyError(interaction, 'Servono almeno 2 giocatori.');

  const result = await poker.startHand(ctx);
  await interaction.reply({ embeds: [handEmbed(result.players), await tableEmbed(ctx)] });
}

async function act(action) {
  return async (interaction) => {
    const ctx = await requireOpenTableInChannel(interaction);
    if (!ctx) return;
    if (ctx.state.stage === 'lobby') return replyError(interaction, 'La partita non è iniziata.');

    let result;
    if (action === 'raise') {
      const amount = interaction.options.getInteger('importo');
      result = await poker.raise(ctx, interaction.user.id, amount);
    } else {
      result = await poker[action](ctx, interaction.user.id);
    }

    const errorMsg = errorMessageFor(result);
    if (errorMsg) return replyError(interaction, errorMsg);

    if (await poker.isBettingClosed(ctx)) {
      const nextStage = await poker.dealNextStreet(ctx);
      if (nextStage.stage === 'showdown') {
        const sd = await poker.showdown(ctx, interaction.guildId);
        return interaction.reply({ embeds: [showdownEmbed(sd, ctx, interaction)] });
      }
      return interaction.reply({ embeds: [await tableEmbed(ctx)] });
    }

    const advanced = await poker.advanceTurn(ctx);
    return interaction.reply({ embeds: [await tableEmbed(advanced.table)] });
  };
}

async function showStatus(interaction) {
  const ctx = await requireOpenTableInChannel(interaction);
  if (!ctx) return;
  await interaction.reply({ embeds: [await tableEmbed(ctx)] });
}

async function endTableCmd(interaction) {
  const ctx = await requireOpenTableInChannel(interaction);
  if (!ctx) return;
  if (ctx.host_id !== interaction.user.id) return replyError(interaction, 'Solo l\'host.');

  await refundPlayers(ctx, interaction.guildId);
  await poker.endTable(ctx.id);

  await interaction.reply(embeds(successEmbed('Chiuso', 'Tavolo chiuso, gettoni rimborsati.')));
}

// --- Helper ---------------------------------------------------------------

async function requireOpenTableInChannel(interaction) {
  const ctx = await poker.getTable(interaction.channelId);
  if (!ctx) {
    replyError(interaction, 'Nessun tavolo in questo canale.');
    return null;
  }
  return ctx;
}

function inBuyInRange(amount) {
  return amount >= BUY_IN_MIN && amount <= BUY_IN_MAX;
}

async function firstPlayerBuyIn(tableId) {
  const players = await poker.listPlayers(tableId);
  return players[0]?.chips;
}

function replyDisabled(interaction) {
  return interaction.reply({ embeds: [errorEmbed('Disabilitato', 'Il poker è disabilitato.')], flags: MessageFlags.Ephemeral });
}

function replyError(interaction, msg) {
  return interaction.reply({ embeds: [errorEmbed('Errore', msg)], flags: MessageFlags.Ephemeral });
}

function embeds(embed) {
  return { embeds: [embed] };
}

function errorMessageFor(result) {
  if (!result?.error) return null;
  switch (result.error) {
    case 'not_in_table': return 'Entra prima al tavolo.';
    case 'not_your_turn': return 'Aspetta il tuo turno.';
    case 'cannot_act': return 'Hai passato o sei all-in.';
    case 'cannot_check': return 'C\'è una puntata — vedi o passa.';
    case 'not_enough': return 'Non hai abbastanza gettoni.';
    case 'min_raise': return `Devi rilanciare almeno ${result.minRaise}.`;
    default: return result.error;
  }
}

async function refundPlayers(ctx, guildId) {
  for (const p of await poker.listPlayers(ctx.id)) {
    const u = await repo.getUser(p.user_id, guildId);
    await repo.updateUser(p.user_id, guildId, { wallet: u.wallet + p.chips });
  }
}

// --- Embed ----------------------------------------------------------------

async function tableEmbed(ctx) {
  const state = ctx.state;
  const players = ctx.players || await poker.listPlayers(ctx.id);

  const playerLines = players.map((p, i) => {
    const marker = i === state.turnIdx ? '▶️' : '  ';
    const folded = p.folded ? ' (passato)' : '';
    const allIn = p.all_in ? ' (all-in)' : '';
    return `${marker} <@${p.user_id}> — gettoni: **${p.chips}**, puntata: **${p.bet}**${folded}${allIn}`;
  });

  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`♠ Poker — ${STAGE_LABELS[state.stage] || state.stage}`)
    .addFields(
      { name: 'Tavolo', value: state.community.length ? state.community.map(cardString).join(' ') : '_nessuna carta_' },
      { name: 'Piatto', value: `${ctx.pot}`, inline: true },
      { name: 'Ultima puntata', value: `${state.lastBet}`, inline: true },
      { name: 'Giocatori', value: playerLines.join('\n') || '_nessuno_' },
    )
    .setTimestamp();
}

function handEmbed(players) {
  const lines = players.map((p) => `<@${p.user_id}>: ${p.hand.map(cardString).join(' ')}`);
  return new EmbedBuilder().setColor(0x5865f2).setTitle('🃏 La tua mano').setDescription(lines.join('\n'));
}

function showdownEmbed(sd, ctx, interaction) {
  const lines = sd.evaluated.map((e) => `<@${e.player.user_id}>: \`${e.hand.rank}\` — ${e.hand.cards.map(cardString).join(' ')}`);
  const title = sd.winner.user_id === interaction.user.id ? '🏆 Hai vinto' : `🏆 Vince <@${sd.winner.user_id}>`;
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`${title} — piatto ${ctx.pot}`)
    .setDescription(lines.join('\n'));
}

module.exports = { data, execute };
