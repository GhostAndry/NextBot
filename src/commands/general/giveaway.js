'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const logger = require('../../utils/logger');

// Giveaway con bottone "Partecipa". Limite: 1 entry per utente. Setta un timer
// (max 7 giorni) per il pick automatico. Persiste in memoria: al restart del
// bot si perdono le entry già raccolte, ma il giveaway resta attivo (potrebbe
// essere "ricostruito" deployando un job ricorrente che rilegge i giveaway
// attivi — non implementato per semplicità).
//
// Subcommands:
//   /giveaway start <premio> <durata> [vincitori]  → crea giveaway
//   /giveaway end <messageId>                     → termina subito
//   /giveaway reroll <messageId>                  → estrae un nuovo vincitore

const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_DURATION_MS = 30 * 1000;

const giveaways = new Map();

const data = new SlashCommandBuilder()
  .setName('giveaway')
  .setDescription('Gestione giveaway')
  .addSubcommand((sc) =>
    sc.setName('start').setDescription('Avvia un giveaway')
      .addStringOption((o) => o.setName('premio').setDescription('Cosa si vince').setRequired(true).setMaxLength(200))
      .addStringOption((o) => o.setName('durata').setDescription('Durata (es. 1h, 30m, 2d)').setRequired(true))
      .addIntegerOption((o) => o.setName('vincitori').setDescription('Quanti vincitori estrarre (1-10)').setMinValue(1).setMaxValue(10).setRequired(false)))
  .addSubcommand((sc) =>
    sc.setName('end').setDescription('Termina subito un giveaway')
      .addStringOption((o) => o.setName('message_id').setDescription('ID del messaggio del giveaway').setRequired(true)))
  .addSubcommand((sc) =>
    sc.setName('reroll').setDescription('Riestrai un nuovo vincitore')
      .addStringOption((o) => o.setName('message_id').setDescription('ID del messaggio del giveaway').setRequired(true)));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'start') return cmdStart(interaction);
  if (sub === 'end') return cmdEnd(interaction);
  if (sub === 'reroll') return cmdReroll(interaction);
}

async function cmdStart(interaction) {
  const premio = interaction.options.getString('premio');
  const durataStr = interaction.options.getString('durata');
  const winnerCount = interaction.options.getInteger('vincitori') || 1;

  const ms = parseDuration(durataStr);
  if (ms === null) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Durata non valida').setDescription('Usa formato come `30s`, `5m`, `2h`, `1d`.').setTimestamp()],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (ms < MIN_DURATION_MS) {
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Troppo breve').setDescription('Durata minima 30 secondi.').setTimestamp()], flags: MessageFlags.Ephemeral });
  }
  if (ms > MAX_DURATION_MS) {
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Troppo lungo').setDescription('Durata massima 7 giorni.').setTimestamp()], flags: MessageFlags.Ephemeral });
  }

  const endsAt = Date.now() + ms;
  const gwId = `gw_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

  // Embed pubblico
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('🎉 Giveaway!')
    .setDescription(`**Premio:** ${premio}\n\nClicca il bottone qui sotto per partecipare!\nVincitori: **${winnerCount}**`)
    .addFields({ name: '⏰ Termina', value: `<t:${Math.floor(endsAt / 1000)}:R>`, inline: true })
    .setFooter({ text: `Avviato da ${interaction.user.tag}` })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gw:join:${gwId}`)
      .setLabel('Partecipa (0)')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🎉'),
  );

  const reply = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });

  giveaways.set(gwId, {
    id: gwId,
    messageId: reply.id,
    channelId: reply.channelId,
    guildId: interaction.guildId,
    hostId: interaction.user.id,
    premio,
    winnerCount,
    endsAt,
    entries: new Set(),
    ended: false,
    timer: null,
  });

  const gw = giveaways.get(gwId);
  gw.timer = setTimeout(() => endGiveaway(gwId, interaction.client).catch((err) => {
    logger.warn({ err: err.message, gwId }, 'giveaway auto-end fallito');
  }), ms);
}

async function cmdEnd(interaction) {
  const messageId = interaction.options.getString('message_id');
  const gw = findGiveawayByMessageId(messageId);
  if (!gw) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Non trovato').setTimestamp()], flags: MessageFlags.Ephemeral });
  if (gw.ended) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle('Già terminato').setTimestamp()], flags: MessageFlags.Ephemeral });
  if (gw.timer) clearTimeout(gw.timer);
  await endGiveaway(gw.id, interaction.client);
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('Terminato').setDescription('Vincitori estratti e annunciati.').setTimestamp()], flags: MessageFlags.Ephemeral });
}

async function cmdReroll(interaction) {
  const messageId = interaction.options.getString('message_id');
  const gw = findGiveawayByMessageId(messageId);
  if (!gw) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Non trovato').setTimestamp()], flags: MessageFlags.Ephemeral });
  if (!gw.ended) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle('Non ancora terminato').setDescription('Usa prima `/giveaway end`.').setTimestamp()], flags: MessageFlags.Ephemeral });
  const remaining = [...gw.entries].filter((id) => !gw.winners.includes(id));
  if (remaining.length === 0) {
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle('Nessun altro partecipante').setTimestamp()], flags: MessageFlags.Ephemeral });
  }
  const newWinner = pickRandom(remaining);
  gw.winners.push(newWinner);
  await announceReroll(interaction.client, gw, newWinner);
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('Nuovo vincitore').setDescription(`<@${newWinner}>`).setTimestamp()], flags: MessageFlags.Ephemeral });
}

function findGiveawayByMessageId(messageId) {
  for (const gw of giveaways.values()) {
    if (gw.messageId === messageId) return gw;
  }
  return null;
}

function parseDuration(str) {
  const m = /^(\d+)(s|m|h|d)$/i.exec(str.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  return { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] * n;
}

async function endGiveaway(gwId, client) {
  const gw = giveaways.get(gwId);
  if (!gw || gw.ended) return;
  gw.ended = true;
  const winners = pickWinners([...gw.entries], gw.winnerCount);
  gw.winners = winners;

  // Aggiorna messaggio embed
  try {
    const channel = await client.channels.fetch(gw.channelId);
    if (channel?.isTextBased?.()) {
      const msg = await channel.messages.fetch(gw.messageId);
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('🎉 Giveaway terminato!')
        .setDescription(
          winners.length > 0
            ? `**Premio:** ${gw.premio}\n\n🏆 Vincitori: ${winners.map((id) => `<@${id}>`).join(', ')}`
            : `**Premio:** ${gw.premio}\n\n😢 Nessun partecipante.`,
        )
        .addFields({ name: 'Partecipanti', value: `${gw.entries.size}`, inline: true })
        .setFooter({ text: `Avviato da <@${gw.hostId}>` })
        .setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gw:join:${gw.id}`).setLabel('Partecipa').setStyle(ButtonStyle.Secondary).setDisabled(true).setEmoji('🎉'),
      );
      await msg.edit({ embeds: [embed], components: [row] });
    }
  } catch (err) {
    logger.warn({ err: err.message, gwId }, 'giveaway: aggiornamento messaggio fallito');
  }

  // Annuncio vincitori nel canale
  try {
    const channel = await client.channels.fetch(gw.channelId);
    if (channel?.isTextBased?.()) {
      const text = winners.length > 0
        ? `🎉 Complimenti a ${winners.map((id) => `<@${id}>`).join(', ')}! Hai vinto **${gw.premio}**!`
        : `😢 Il giveaway per **${gw.premio}** si è chiuso senza vincitori.`;
      await channel.send({ content: text });
    }
  } catch (err) {
    logger.warn({ err: err.message, gwId }, 'giveaway: annuncio vincitori fallito');
  }

  // Cleanup dopo 1h
  setTimeout(() => giveaways.delete(gwId), 60 * 60 * 1000);
}

async function announceReroll(client, gw, winnerId) {
  try {
    const channel = await client.channels.fetch(gw.channelId);
    if (channel?.isTextBased?.()) {
      await channel.send({ content: `🎉 Nuovo vincitore (reroll) per **${gw.premio}**: <@${winnerId}>!` });
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'giveaway reroll annuncio fallito');
  }
}

function pickWinners(entries, count) {
  if (entries.length === 0) return [];
  const pool = [...entries];
  const winners = [];
  for (let i = 0; i < Math.min(count, pool.length); i++) {
    const idx = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(idx, 1)[0]);
  }
  return winners;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function handleComponent(interaction) {
  if (!interaction.isButton()) return false;
  const parts = interaction.customId.split(':');
  if (parts.length !== 3 || parts[0] !== 'gw' || parts[1] !== 'join') return false;
  const gwId = parts[2];
  const gw = giveaways.get(gwId);
  if (!gw) {
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Giveaway terminato').setTimestamp()], flags: MessageFlags.Ephemeral });
  }
  if (gw.ended) {
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle('Giveaway terminato').setDescription('Non è più possibile partecipare.').setTimestamp()], flags: MessageFlags.Ephemeral });
  }
  const userId = interaction.user.id;
  let joined = false;
  if (gw.entries.has(userId)) {
    gw.entries.delete(userId);
  } else {
    gw.entries.add(userId);
    joined = true;
  }
  // Aggiorna bottone col conteggio
  try {
    const channel = await interaction.client.channels.fetch(gw.channelId);
    if (channel?.isTextBased?.()) {
      const msg = await channel.messages.fetch(gw.messageId);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`gw:join:${gwId}`)
          .setLabel(`Partecipa (${gw.entries.size})`)
          .setStyle(joined ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setEmoji('🎉'),
      );
      await msg.edit({ components: [row] });
    }
  } catch (err) {
    logger.warn({ err: err.message, gwId }, 'giveaway: aggiornamento conteggio fallito');
  }
  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(joined ? 0x57f287 : 0xfee75c).setTitle(joined ? '🎉 Partecipi!' : '😌 Hai lasciato il giveaway').setTimestamp()],
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = { data, execute, handleComponent };
