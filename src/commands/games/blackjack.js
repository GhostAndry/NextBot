'use strict';

const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const repo = require('../../db/repo');
const { errorEmbed } = require('../../utils/helpers');
const { cardString, handTotal, handStr, newDeck, deal, popCard } = require('./blackjack-cards');

const COOLDOWN_TO_DELETE_MS = 60_000;
const ACTIONS = {
  HIT: 'hit',
  STAND: 'stand',
  DOUBLE: 'double',
};

const STATUS_LABELS = {
  blackjack: 'BLACKJACK',
  bust: 'SBALLATO',
  dealer_bust: 'BANCO SBALLATO',
  win: 'VITTORIA',
  push: 'PAREGGIO',
  lose: 'SCONFITTA',
};

// --- Definizione comando ---------------------------------------------------

const data = new SlashCommandBuilder()
  .setName('blackjack')
  .setDescription('Blackjack contro il banco')
  .addSubcommand((sc) => sc.setName('start').setDescription('Inizia una nuova partita').addIntegerOption((o) => o.setName('puntata').setDescription('Importo della puntata').setRequired(true).setMinValue(1)))
  .addSubcommand((sc) => sc.setName('hit').setDescription('Pesca una carta'))
  .addSubcommand((sc) => sc.setName('stand').setDescription('Fermati con la mano attuale'))
  .addSubcommand((sc) => sc.setName('double').setDescription('Raddoppia'));

const customId = (action) => `blackjack:${action}`;

// --- Dispatcher -----------------------------------------------------------

async function execute(interaction, subcommand = null) {
  if (!config.features.blackjack.enabled) {
    return replyDisabled(interaction);
  }

  const sub = subcommand || interaction.options.getSubcommand();
  const handler = SUBCOMMAND_HANDLERS[sub];
  if (!handler) return replyError(interaction, 'Sottocomando sconosciuto.');
  return handler(interaction);
}

const SUBCOMMAND_HANDLERS = {
  start: cmdStart,
  hit: cmdHit,
  stand: cmdStand,
  double: cmdDouble,
};

// --- Sottocomandi ---------------------------------------------------------

async function cmdStart(interaction) {
  const bet = interaction.options.getInteger('puntata');
  const { min, max } = config.features.blackjack;
  if (bet < min || bet > max) return replyError(interaction, `La puntata deve essere tra ${min} e ${max}.`);

  const user = await repo.getUser(interaction.user.id, interaction.guildId);
  if (user.wallet < bet) return replyError(interaction, `Il tuo portafoglio ha ${user.wallet}.`);

  const existing = await repo.getBlackjackSession(interaction.user.id, interaction.guildId);
  if (existing && existing.status === 'playing') return replyError(interaction, 'Hai già una partita in corso.');

  const deck = newDeck();
  const player = deal(deck, 2);
  const dealer = deal(deck, 2);
  const session = { deck, player, dealer, bet, status: 'playing' };

  await repo.updateUser(interaction.user.id, interaction.guildId, { wallet: user.wallet - bet });
  await repo.saveBlackjackSession(interaction.user.id, interaction.guildId, session);

  if (handTotal(player) === 21) {
    return resolve(interaction, session, { naturalBlackjack: true });
  }
  return replyGame(interaction, session);
}

async function cmdHit(interaction) {
  const session = await requireActive(interaction);
  if (!session) return;

  session.player.push(popCard(session.deck));
  await repo.saveBlackjackSession(interaction.user.id, interaction.guildId, session);

  if (handTotal(session.player) > 21) {
    return resolve(interaction, session, { forcedStatus: 'bust' });
  }
  return replyGame(interaction, session);
}

async function cmdStand(interaction) {
  const session = await requireActive(interaction);
  if (!session) return;
  return resolve(interaction, session, {});
}

async function cmdDouble(interaction) {
  const session = await requireActive(interaction);
  if (!session) return;

  const user = await repo.getUser(interaction.user.id, interaction.guildId);
  if (user.wallet < session.bet) return replyError(interaction, 'Non puoi raddoppiare.');

  await repo.updateUser(interaction.user.id, interaction.guildId, { wallet: user.wallet - session.bet });
  session.bet *= 2;
  session.player.push(popCard(session.deck));
  await repo.saveBlackjackSession(interaction.user.id, interaction.guildId, session);

  if (handTotal(session.player) > 21) {
    return resolve(interaction, session, { forcedStatus: 'bust' });
  }
  return resolve(interaction, session, {});
}

async function requireActive(interaction) {
  const session = await repo.getBlackjackSession(interaction.user.id, interaction.guildId);
  if (!session || session.status !== 'playing') {
    replyError(interaction, 'Iniziane una con /blackjack start.');
    return null;
  }
  return session;
}

// --- Risoluzione e pagamento ----------------------------------------------

async function resolve(interaction, session, { naturalBlackjack = false, forcedStatus = null } = {}) {
  while (handTotal(session.dealer) < 17) session.dealer.push(popCard(session.deck));

  const playerTotal = handTotal(session.player);
  const dealerTotal = handTotal(session.dealer);

  const result = computeResult(playerTotal, dealerTotal, session.bet, { naturalBlackjack, forcedStatus });

  if (result.payout > 0) {
    const user = await repo.getUser(interaction.user.id, interaction.guildId);
    await repo.updateUser(interaction.user.id, interaction.guildId, {
      wallet: user.wallet + Math.floor(result.payout),
    });
  }

  session.status = result.status;
  await repo.saveBlackjackSession(interaction.user.id, interaction.guildId, session);

  scheduleSessionCleanup(interaction.user.id, interaction.guildId);

  await interaction.reply({ embeds: [gameEmbed(session, false)] });
}

function computeResult(playerTotal, dealerTotal, bet, { naturalBlackjack, forcedStatus }) {
  if (forcedStatus) return { status: forcedStatus, payout: 0 };

  if (naturalBlackjack && dealerTotal !== 21) return { status: 'blackjack', payout: bet * 2.5 };
  if (playerTotal > 21) return { status: 'bust', payout: 0 };
  if (dealerTotal > 21) return { status: 'dealer_bust', payout: bet * 2 };
  if (playerTotal > dealerTotal) return { status: 'win', payout: bet * 2 };
  if (playerTotal === dealerTotal) return { status: 'push', payout: bet };
  return { status: 'lose', payout: 0 };
}

function scheduleSessionCleanup(userId, guildId) {
  setTimeout(() => {
    repo.deleteBlackjackSession(userId, guildId).catch(() => {});
  }, COOLDOWN_TO_DELETE_MS);
}

// --- Gestione componenti ---------------------------------------------------

async function handleComponent(interaction) {
  if (!interaction.customId.startsWith('blackjack:')) return false;
  const sub = interaction.customId.split(':')[1];
  await execute(interaction, sub);
  return true;
}

// --- Embed e bottoni -------------------------------------------------------

function gameEmbed(session, hideDealer) {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🃏 Blackjack')
    .addFields(
      { name: `Banco (${hideDealer ? '?' : handTotal(session.dealer)})`, value: handStr(session.dealer, hideDealer) },
      { name: `Tu (${handTotal(session.player)})`, value: handStr(session.player) },
      { name: 'Puntata', value: `${session.bet}` },
    )
    .setFooter(session.status !== 'playing' ? { text: `Esito: ${STATUS_LABELS[session.status] || session.status.toUpperCase()}` } : null)
    .setTimestamp();
}

function actionRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId(ACTIONS.HIT)).setLabel('Pesca').setStyle(ButtonStyle.Primary).setEmoji('👊').setDisabled(disabled),
    new ButtonBuilder().setCustomId(customId(ACTIONS.STAND)).setLabel('Fermo').setStyle(ButtonStyle.Secondary).setEmoji('✋').setDisabled(disabled),
    new ButtonBuilder().setCustomId(customId(ACTIONS.DOUBLE)).setLabel('Raddoppia').setStyle(ButtonStyle.Danger).setEmoji('💰').setDisabled(disabled),
  );
}

async function replyGame(interaction, session) {
  await interaction.reply({ embeds: [gameEmbed(session, true)], components: [actionRow()] });
}

function replyDisabled(interaction) {
  return interaction.reply({ embeds: [errorEmbed('Disabilitato', 'Il blackjack è disabilitato.')], flags: MessageFlags.Ephemeral });
}

function replyError(interaction, message) {
  return interaction.reply({ embeds: [errorEmbed('Errore', message)], flags: MessageFlags.Ephemeral });
}

module.exports = { data, execute, handleComponent };
