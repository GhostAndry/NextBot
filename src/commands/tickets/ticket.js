'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, PermissionsBitField, MessageFlags } = require('discord.js');
const config = require('../../config');
const repo = require('../../db/repo');
const { successEmbed, errorEmbed, hasPermission } = require('../../utils/helpers');
const logger = require('../../utils/logger');
const transcriptSvc = require('../../services/ticket-transcript');

const CLOSE_DELAY_MS = 5_000;
const TICKET_CLAIM_ID = 'ticket:claim';
const TICKET_CLOSE_ID = 'ticket:close';
const TICKET_CLOSE_CONFIRM_ID = 'ticket:closeconfirm';
const TICKET_CLOSE_CANCEL_ID = 'ticket:closecancel';
const TICKET_OPEN_ID = 'ticket:open';
const TICKET_FORM_ID = 'ticket:form';

// Protezione contro doppio click "Conferma chiusura". Senza questo set, due
// click consecutivi (es. prima del re-render del messaggio) fanno partire
// `finalizeTicket` due volte: due transcript, due log, due cancellazioni.
const closingTickets = new Set();

// --- Definizione comando ---------------------------------------------------

const data = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Sistema di ticket')
  .addSubcommand((sc) => sc.setName('open').setDescription('Apri un nuovo ticket'))
  .addSubcommand((sc) => sc.setName('panel').setDescription('Invia il pannello con il bottone "Apri un ticket"').addChannelOption((o) => o.setName('canale').setDescription('Canale dove inviare (default: quello attuale)').setRequired(false)))
  .addSubcommand((sc) => sc.setName('close').setDescription('Chiudi il ticket attuale'))
  .addSubcommand((sc) => sc.setName('add').setDescription('Aggiungi un utente al ticket').addUserOption((o) => o.setName('utente').setDescription('Utente da aggiungere').setRequired(true)))
  .addSubcommand((sc) => sc.setName('remove').setDescription('Rimuovi un utente dal ticket').addUserOption((o) => o.setName('utente').setDescription('Utente da rimuovere').setRequired(true)))
  .addSubcommand((sc) => sc.setName('claim').setDescription('Prendi in carico questo ticket'))
  .addSubcommand((sc) => sc.setName('transcript').setDescription('Salva e invia la trascrizione'));

// --- Dispatcher -----------------------------------------------------------

async function execute(interaction) {
  if (!config.features.tickets.enabled) return disabled(interaction);
  const handler = SUBCOMMAND_HANDLERS[interaction.options.getSubcommand()];
  if (!handler) return error(interaction, 'Sottocomando sconosciuto.');
  return handler(interaction);
}

const SUBCOMMAND_HANDLERS = {
  open: cmdOpen,
  panel: cmdPanel,
  close: cmdClose,
  add: cmdAdd,
  remove: cmdRemove,
  claim: cmdClaim,
  transcript: cmdTranscript,
};

// --- Sottocomandi ---------------------------------------------------------

async function cmdOpen(interaction) {
  const guard = await checkCanOpen(interaction);
  if (guard) return guard;

  await interaction.showModal(buildTicketForm());
}

async function cmdPanel(interaction) {
  if (!hasPermission(interaction.member, PermissionFlagsBits.ManageChannels)) {
    return error(interaction, 'Solo lo staff può farlo.');
  }

  const channel = interaction.options.getChannel('canale') || interaction.channel;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_OPEN_ID)
      .setLabel('Apri un ticket')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🎫'),
  );

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Supporto')
    .setDescription('Hai bisogno di aiuto? Clicca il bottone qui sotto per aprire un ticket.')
    .setFooter({ text: 'Un ticket alla volta per utente.' })
    .setTimestamp();

  await channel.send({ embeds: [embed], components: [row] });
  await interaction.reply({ embeds: [successEmbed('Pannello inviato', `Inviato in ${channel}.`)], flags: MessageFlags.Ephemeral });
}

async function cmdClose(interaction) {
  const ticket = await repo.getOpenTicketByChannel(interaction.channelId);
  if (!ticket) return error(interaction, 'Questo comando funziona solo nei canali ticket.');
  if (!userCanManageTicket(interaction, ticket)) return error(interaction, 'Non puoi chiudere questo ticket.');

  await interaction.reply(closeConfirmation());
}

async function cmdAdd(interaction) {
  const ticket = await repo.getOpenTicketByChannel(interaction.channelId);
  if (!ticket) return error(interaction, 'Esegui questo comando dentro un canale ticket.');
  if (!userCanManageTicket(interaction, ticket)) return error(interaction, 'Non puoi aggiungere utenti qui.');

  const user = interaction.options.getUser('utente');
  await interaction.channel.permissionOverwrites.edit(user.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  });
  return interaction.reply({ embeds: [successEmbed('Aggiunto', `<@${user.id}> aggiunto al ticket.`)], flags: MessageFlags.Ephemeral });
}

async function cmdRemove(interaction) {
  const ticket = await repo.getOpenTicketByChannel(interaction.channelId);
  if (!ticket) return error(interaction, 'Esegui questo comando dentro un canale ticket.');
  if (!hasPermission(interaction.member, PermissionFlagsBits.ManageChannels)) {
    return error(interaction, 'Solo lo staff.');
  }

  const user = interaction.options.getUser('utente');
  await interaction.channel.permissionOverwrites.delete(user.id).catch(() => {});
  return interaction.reply({ embeds: [successEmbed('Rimosso', `<@${user.id}> rimosso dal ticket.`)], flags: MessageFlags.Ephemeral });
}

async function cmdClaim(interaction) {
  const ticket = await repo.getOpenTicketByChannel(interaction.channelId);
  if (!ticket) return error(interaction, 'Esegui questo comando dentro un canale ticket.');
  if (!hasPermission(interaction.member, PermissionFlagsBits.ManageChannels)) {
    return error(interaction, 'Solo lo staff.');
  }

  await repo.claimTicket(interaction.channelId, interaction.user.id);
  await interaction.channel.send({ embeds: [successEmbed('Preso in carico', `<@${interaction.user.id}> si sta occupando di questo ticket.`)] });
  return interaction.reply({ embeds: [successEmbed('Preso in carico', 'Hai preso in carico questo ticket.')], flags: MessageFlags.Ephemeral });
}

async function cmdTranscript(interaction) {
  const ticket = await repo.getOpenTicketByChannel(interaction.channelId);
  if (!ticket) return error(interaction, 'Esegui questo comando dentro un canale ticket.');
  if (!userCanManageTicket(interaction, ticket)) return error(interaction, 'Non puoi esportare questo ticket.');

  const buffer = await transcriptSvc.build(interaction.channel);
  await interaction.reply({ files: [{ attachment: buffer, name: `trascrizione-${ticket.channel_id}.html` }] });
}

// --- Gestione componenti ---------------------------------------------------

async function handleComponent(interaction) {
  if (interaction.isButton() && interaction.customId === TICKET_OPEN_ID) {
    return onOpenButton(interaction);
  }
  if (interaction.isButton() && interaction.customId === TICKET_CLAIM_ID) {
    return onClaimButton(interaction);
  }
  if (interaction.isButton() && interaction.customId === TICKET_CLOSE_ID) {
    return onCloseButton(interaction);
  }
  if (interaction.isButton() && interaction.customId === TICKET_CLOSE_CONFIRM_ID) {
    return onCloseConfirmButton(interaction);
  }
  if (interaction.isButton() && interaction.customId === TICKET_CLOSE_CANCEL_ID) {
    return onCloseCancelButton(interaction);
  }
  return false;
}

async function handleModal(interaction) {
  if (interaction.customId !== TICKET_FORM_ID) return false;
  return onTicketFormSubmit(interaction);
}

// --- Flusso: click -> modal -> crea canale ---------------------------------

async function onOpenButton(interaction) {
  const guard = await checkCanOpen(interaction);
  if (guard) return guard;

  await interaction.showModal(buildTicketForm());
  return true;
}

async function onTicketFormSubmit(interaction) {
  const subject = interaction.fields.getTextInputValue('oggetto')?.trim();
  const description = interaction.fields.getTextInputValue('descrizione')?.trim();
  const attachmentsField = interaction.fields.getTextInputValue('allegati')?.trim() || '';

  if (!subject || subject.length < 3) {
    return interaction.reply({ embeds: [errorEmbed('Oggetto mancante', 'Inserisci un titolo breve (almeno 3 caratteri).')], flags: MessageFlags.Ephemeral });
  }
  if (!description || description.length < 10) {
    return interaction.reply({ embeds: [errorEmbed('Descrizione mancante', 'Descrivi il problema in almeno 10 caratteri.')], flags: MessageFlags.Ephemeral });
  }

  const attachmentLines = parseAttachmentLines(attachmentsField);
  const reasonText = [
    `**Oggetto:** ${subject}`,
    `**Descrizione:**\n${description}`,
    attachmentLines.length ? `**Allegati:**\n${attachmentLines.join('\n')}` : '_nessun allegato_',
  ].join('\n\n');

  await createTicketChannel(interaction, reasonText);
  await interaction.reply({ embeds: [successEmbed('Ticket creato', 'Il tuo ticket è ora aperto.')], flags: MessageFlags.Ephemeral });
}

// --- Creazione canale -----------------------------------------------------

async function createTicketChannel(interaction, reasonText) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  const parentId = await resolveTicketCategory(interaction);
  const channelName = makeChannelName(interaction.user.username);

  let channel;
  try {
    channel = await interaction.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: parentId || interaction.channel.parentId,
      topic: `Ticket di ${interaction.user.tag}`,
      permissionOverwrites: buildPermissionOverwrites(interaction),
    });
  } catch (err) {
    logger.error({ err }, 'creazione ticket fallita');
    await interaction.followUp?.({ embeds: [errorEmbed('Errore', 'Impossibile creare il canale ticket. Controlla la categoria e i permessi del bot.')], flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  await repo.createTicket(guildId, channel.id, userId);

  const introEmbed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
    .setTitle(`Ticket: ${interaction.user.username}`)
    .setDescription(reasonText)
    .setFooter({ text: 'Lo staff ti risponderà a breve.' })
    .setTimestamp();

  await channel.send({
    content: `<@${userId}> lo staff ti risponderà a breve.`,
    embeds: [introEmbed],
    components: [ticketActionRow()],
  });
}

// --- Bottoni --------------------------------------------------------------

async function onClaimButton(interaction) {
  const ticket = await repo.getOpenTicketByChannel(interaction.channelId);
  if (!ticket) return error(interaction, 'Ticket chiuso.');
  if (!hasPermission(interaction.member, PermissionFlagsBits.ManageChannels)) {
    return error(interaction, 'Solo lo staff.');
  }
  await repo.claimTicket(interaction.channelId, interaction.user.id);
  await interaction.reply({ embeds: [successEmbed('Preso in carico', `<@${interaction.user.id}> ha preso in carico questo ticket.`)] });
  return true;
}

async function onCloseButton(interaction) {
  const ticket = await repo.getOpenTicketByChannel(interaction.channelId);
  if (!ticket) return error(interaction, 'Ticket già chiuso.');
  if (!userCanManageTicket(interaction, ticket)) {
    return interaction.reply({ embeds: [errorEmbed('Permesso negato', 'Non puoi chiudere questo ticket.')], flags: MessageFlags.Ephemeral });
  }

  await interaction.reply(closeConfirmation());
  return true;
}

async function onCloseConfirmButton(interaction) {
  const ticket = await repo.getOpenTicketByChannel(interaction.channelId);
  if (!ticket) {
    await interaction.update({ embeds: [errorEmbed('Ticket chiuso', 'Questo ticket è già stato chiuso.')], components: [] });
    return true;
  }
  if (!userCanManageTicket(interaction, ticket)) {
    await interaction.update({ embeds: [errorEmbed('Permesso negato', 'Non puoi chiudere questo ticket.')], components: [] });
    return true;
  }

  // Idempotency: protezione contro doppio click. Il primo click wins,
  // i successivi ricevono un messaggio ephemeral senza rilanciare effetti.
  if (closingTickets.has(interaction.channelId)) {
    return interaction.reply({ embeds: [errorEmbed('Già in corso', 'La chiusura è già stata avviata.')], flags: MessageFlags.Ephemeral });
  }
  closingTickets.add(interaction.channelId);
  // Rilascia il lock dopo che il canale sarà eliminato (5s + margine).
  setTimeout(() => closingTickets.delete(interaction.channelId), CLOSE_DELAY_MS * 2);

  await interaction.update({
    embeds: [successEmbed('Chiusura in corso', 'Il ticket verrà eliminato tra 5 secondi.')],
    components: [],
  });

  await finalizeTicket(interaction, ticket);
  scheduleChannelDelete(interaction.channel, CLOSE_DELAY_MS);
  return true;
}

async function onCloseCancelButton(interaction) {
  await interaction.update({
    embeds: [successEmbed('Chiusura annullata', 'Il ticket resta aperto.')],
    components: [],
  });
  return true;
}

// --- Chiusura -------------------------------------------------------------

async function finalizeTicket(interaction, ticket) {
  if (config.features.tickets.transcriptOnClose) {
    const buffer = await transcriptSvc.build(interaction.channel);
    await sendTranscriptLog(interaction, ticket, buffer);
  }
  await repo.closeTicket(interaction.channelId);
}

async function sendTranscriptLog(interaction, ticket, buffer) {
  const logChannelId = await resolveTicketLogChannel(interaction);
  if (!logChannelId) return;
  const channel = interaction.guild.channels.cache.get(logChannelId);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('Ticket chiuso')
    .addFields(
      { name: 'Aperto da', value: `<@${ticket.user_id}>`, inline: true },
      { name: 'Chiuso da', value: `<@${interaction.user.id}>`, inline: true },
    )
    .setTimestamp();

  await channel.send({
    embeds: [embed],
    files: [{ attachment: buffer, name: `trascrizione-${ticket.channel_id}.html` }],
  }).catch(() => {});
}

function scheduleChannelDelete(channel, delayMs) {
  setTimeout(() => channel.delete('ticket chiuso').catch(() => {}), delayMs);
}

// --- Builder ---------------------------------------------------------------

function buildTicketForm() {
  const subject = new TextInputBuilder()
    .setCustomId('oggetto')
    .setLabel('Oggetto (titolo breve)')
    .setStyle(TextInputStyle.Short)
    .setMinLength(3)
    .setMaxLength(80)
    .setRequired(true);

  const description = new TextInputBuilder()
    .setCustomId('descrizione')
    .setLabel('Descrivi il problema (min 10 caratteri)')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(10)
    .setMaxLength(1500)
    .setRequired(true);

  const attachments = new TextInputBuilder()
    .setCustomId('allegati')
    .setLabel('URL degli allegati (uno per riga)')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000)
    .setRequired(false);

  return new ModalBuilder()
    .setCustomId(TICKET_FORM_ID)
    .setTitle('Apri un ticket')
    .addComponents(
      new ActionRowBuilder().addComponents(subject),
      new ActionRowBuilder().addComponents(description),
      new ActionRowBuilder().addComponents(attachments),
    );
}

function ticketActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(TICKET_CLAIM_ID).setLabel('Prendi in carico').setStyle(ButtonStyle.Primary).setEmoji('✋'),
    new ButtonBuilder().setCustomId(TICKET_CLOSE_ID).setLabel('Chiudi').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
  );
}

// Messaggio di conferma chiusura con pulsanti Conferma/Annulla.
// Usato sia da /ticket close sia dal bottone "Chiudi" nel canale.
function closeConfirmation() {
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('Confermi la chiusura?')
    .setDescription('Il ticket verrà chiuso e il canale eliminato. Questa azione non è reversibile.')
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(TICKET_CLOSE_CONFIRM_ID).setLabel('Conferma').setStyle(ButtonStyle.Danger).setEmoji('✅'),
    new ButtonBuilder().setCustomId(TICKET_CLOSE_CANCEL_ID).setLabel('Annulla').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
  );

  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}

function buildPermissionOverwrites(interaction) {
  return [
    { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
    { id: interaction.client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
  ];
}

// --- Guardie e parsing -----------------------------------------------------

async function checkCanOpen(interaction) {
  const userId = interaction.user.id;

  if (await repo.getOpenTicketByUser(interaction.guildId, userId)) {
    return interaction.reply({ embeds: [errorEmbed('Ticket già aperto', 'Hai già un ticket aperto.')], flags: MessageFlags.Ephemeral });
  }
  if (await openTicketQuotaReached(interaction.guildId)) {
    return interaction.reply({ embeds: [errorEmbed('Limite raggiunto', 'Ci sono troppi ticket aperti al momento.')], flags: MessageFlags.Ephemeral });
  }
  return null;
}

function userCanManageTicket(interaction, ticket) {
  if (ticket.user_id === interaction.user.id) return true;
  return hasPermission(interaction.member, PermissionFlagsBits.ManageChannels);
}

async function openTicketQuotaReached(guildId) {
  const count = await repo.countOpenTickets(guildId);
  return count >= config.features.tickets.maxPerUser * 10;
}

function makeChannelName(username) {
  return `ticket-${username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90);
}

async function resolveTicketCategory(interaction) {
  const cfg = await repo.getGuildConfig(interaction.guildId);
  return cfg.ticket_category_id || config.features.tickets.categoryId || null;
}

async function resolveTicketLogChannel(interaction) {
  const cfg = await repo.getGuildConfig(interaction.guildId);
  return cfg.ticket_log_channel_id || config.features.tickets.logChannelId || null;
}

const URL_REGEX = /\bhttps?:\/\/\S+/;

function parseAttachmentLines(raw) {
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.filter((l) => URL_REGEX.test(l)).slice(0, 5);
}

function disabled(interaction) {
  return interaction.reply({ embeds: [errorEmbed('Disabilitato', 'I ticket sono disabilitati.')], flags: MessageFlags.Ephemeral });
}

function error(interaction, msg) {
  return interaction.reply({ embeds: [errorEmbed('Errore', msg)], flags: MessageFlags.Ephemeral });
}

module.exports = { data, execute, handleComponent, handleModal };
