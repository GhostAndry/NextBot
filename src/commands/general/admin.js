'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const repo = require('../../db/repo');
const { errorEmbed, successEmbed } = require('../../utils/helpers');
const logger = require('../../utils/logger');

const data = new SlashCommandBuilder()
  .setName('admin')
  .setDescription('Comandi di amministrazione')
  .addSubcommandGroup((group) =>
    group.setName('ticket').setDescription('Configura il sistema ticket')
      .addSubcommand((sc) => sc.setName('setup').setDescription('Crea categoria ticket e canale dei log')
        .addStringOption((o) => o.setName('nome').setDescription('Nome della categoria').setRequired(false))
        .addBooleanOption((o) => o.setName('crea_log').setDescription('Crea anche un canale per i log').setRequired(false)),
      )
      .addSubcommand((sc) => sc.setName('channel').setDescription('Collega i ticket a una categoria esistente').addChannelOption((o) => o.setName('categoria').setDescription('Categoria esistente').addChannelTypes(ChannelType.GuildCategory).setRequired(true)))
      .addSubcommand((sc) => sc.setName('log').setDescription('Collega i log a un canale esistente').addChannelOption((o) => o.setName('canale').setDescription('Canale esistente').addChannelTypes(ChannelType.GuildText).setRequired(true)))
      .addSubcommand((sc) => sc.setName('show').setDescription('Mostra la configurazione ticket attuale')),
  )
  .addSubcommandGroup((group) =>
    group.setName('voice').setDescription('Configura i canali vocali temporanei')
      .addSubcommand((sc) => sc.setName('setup').setDescription('Crea il canale hub vocale').addStringOption((o) => o.setName('nome').setDescription('Nome dell\'hub').setRequired(false)))
      .addSubcommand((sc) => sc.setName('channel').setDescription('Collega il sistema vocale a un canale esistente').addChannelOption((o) => o.setName('canale').setDescription('Canale vocale esistente').addChannelTypes(ChannelType.GuildVoice).setRequired(true)))
      .addSubcommand((sc) => sc.setName('show').setDescription('Mostra la configurazione vocale attuale')),
  )
  .addSubcommandGroup((group) =>
    group.setName('deploy').setDescription('Gestione registrazione comandi')
      .addSubcommand((sc) => sc.setName('sync').setDescription('Rimuovi comandi obsoleti e ridistribuisci'))
      .addSubcommand((sc) => sc.setName('wipe').setDescription('Elimina tutti i comandi e ridistribuisci da zero'))
      .addSubcommand((sc) => sc.setName('dryrun').setDescription('Anteprima del diff senza modifiche'))
      .addSubcommand((sc) => sc.setName('remove').setDescription('Elimina comandi specifici per nome').addStringOption((o) => o.setName('nomi').setDescription('Nomi separati da virgola').setRequired(true)))
      .addSubcommand((sc) => sc.setName('unregister').setDescription('Deregistra TUTTI i comandi guild su OGNI guild del bot').addBooleanOption((o) => o.setName('includi_globali').setDescription('Elimina anche i comandi globali').setRequired(false)))
      .addSubcommand((sc) => sc.setName('list').setDescription('Mostra dove sono registrati i comandi (guild vs globali)')),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function execute(interaction) {
  const group = interaction.options.getSubcommandGroup();
  const sub = interaction.options.getSubcommand();
  const handler = HANDLERS[`${group}:${sub}`];
  if (!handler) return error(interaction, 'Sottocomando sconosciuto.');
  return handler(interaction);
}

const HANDLERS = {
  'ticket:setup': setupTickets,
  'ticket:channel': setTicketCategory,
  'ticket:log': setTicketLog,
  'ticket:show': showTicketConfig,
  'voice:setup': setupVoice,
  'voice:channel': setVoiceHub,
  'voice:show': showVoiceConfig,
  'deploy:sync': deploySync,
  'deploy:wipe': deployWipe,
  'deploy:dryrun': deployDryRun,
  'deploy:remove': deployRemove,
  'deploy:unregister': deployUnregister,
  'deploy:list': deployList,
};

// --- Sottocomandi ticket ---------------------------------------------------

async function setupTickets(interaction) {
  const name = interaction.options.getString('nome') || 'Ticket';
  const createLog = interaction.options.getBoolean('crea_log') ?? true;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const category = await safeCreate(interaction.guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ],
    reason: 'Ticket: setup categoria',
  }), interaction, 'categoria');

  if (!category) return;

  await repo.setGuildConfig(interaction.guildId, { ticket_category_id: category.id });

  let logChannel = null;
  if (createLog) {
    logChannel = await safeCreate(interaction.guild.channels.create({
      name: 'ticket-log',
      type: ChannelType.GuildText,
      parent: null,
      permissionOverwrites: [
        { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ],
      reason: 'Ticket: setup canale log',
    }), interaction, 'canale log');

    if (logChannel) {
      await repo.setGuildConfig(interaction.guildId, { ticket_log_channel_id: logChannel.id });
    }
  }

  const summary = `Categoria: ${category}${logChannel ? ` — Log: ${logChannel}` : ''}`;
  await interaction.editReply({ embeds: [successEmbed('Ticket configurati', summary)] });
}

async function setTicketCategory(interaction) {
  const category = interaction.options.getChannel('categoria');
  if (category.type !== ChannelType.GuildCategory) {
    return error(interaction, 'Scegli un canale categoria.');
  }
  await repo.setGuildConfig(interaction.guildId, { ticket_category_id: category.id });
  await interaction.reply({ embeds: [successEmbed('Categoria ticket impostata', `${category}`)], flags: MessageFlags.Ephemeral });
}

async function setTicketLog(interaction) {
  const channel = interaction.options.getChannel('canale');
  if (channel.type !== ChannelType.GuildText) {
    return error(interaction, 'Scegli un canale testuale.');
  }
  await repo.setGuildConfig(interaction.guildId, { ticket_log_channel_id: channel.id });
  await interaction.reply({ embeds: [successEmbed('Canale log impostato', `${channel}`)], flags: MessageFlags.Ephemeral });
}

async function showTicketConfig(interaction) {
  const cfg = await repo.getGuildConfig(interaction.guildId);
  const lines = [
    `Categoria: ${fmtChannel(interaction.guild, cfg.ticket_category_id)}`,
    `Log: ${fmtChannel(interaction.guild, cfg.ticket_log_channel_id)}`,
    `Trascrizione alla chiusura: ${config.features.tickets.transcriptOnClose ? '✅' : '❌'}`,
    `Massimo per utente: ${config.features.tickets.maxPerUser}`,
  ];
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🎫 Config ticket').setDescription(lines.join('\n'));
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// --- Sottocomandi voice ----------------------------------------------------

async function setupVoice(interaction) {
  const name = interaction.options.getString('nome') || '➕ Crea un canale';

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = await safeCreate(interaction.guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    permissionOverwrites: [
      { id: interaction.guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
      { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels] },
    ],
    reason: 'Voice: setup hub',
  }), interaction, 'hub vocale');

  if (!channel) return;

  await repo.setGuildConfig(interaction.guildId, { temp_voice_hub_id: channel.id });
  await interaction.editReply({
    embeds: [
      successEmbed(
        'Hub vocale configurato',
        `Chi entra in **${channel.name}** riceverà un canale temporaneo privato.\n` +
        `Auto-elimina dopo ${config.features.tempChannels.autoDeleteSecondsEmpty}s vuoto.`,
      ),
    ],
  });
}

async function setVoiceHub(interaction) {
  const channel = interaction.options.getChannel('canale');
  if (channel.type !== ChannelType.GuildVoice) {
    return error(interaction, 'Scegli un canale vocale.');
  }
  await repo.setGuildConfig(interaction.guildId, { temp_voice_hub_id: channel.id });
  await interaction.reply({ embeds: [successEmbed('Hub vocale impostato', `${channel}`)], flags: MessageFlags.Ephemeral });
}

async function showVoiceConfig(interaction) {
  const cfg = await repo.getGuildConfig(interaction.guildId);
  const lines = [
    `Hub: ${fmtChannel(interaction.guild, cfg.temp_voice_hub_id)}`,
    `Auto-elimina (s): ${config.features.tempChannels.autoDeleteSecondsEmpty}`,
    `Limite utenti predefinito: ${config.features.tempChannels.defaultUserLimit === 0 ? 'illimitato' : config.features.tempChannels.defaultUserLimit}`,
  ];
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🔊 Config voce').setDescription(lines.join('\n'));
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// --- Sottocomandi deploy ---------------------------------------------------

const {
  deployCommands,
  removeCommandsByName,
  wipeAllGuildCommands,
  listRegisteredCommands,
} = require('../../handlers/registry');

async function deploySync(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await deployCommands({ wipe: false, dryRun: false });
  if (!result) return interaction.editReply({ embeds: [errorEmbed('Errore', 'Credenziali Discord mancanti.')] });
  await interaction.editReply({ embeds: [deployResultEmbed('Sincronizzato', result)] });
}

async function deployWipe(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await deployCommands({ wipe: true, dryRun: false });
  if (!result) return interaction.editReply({ embeds: [errorEmbed('Errore', 'Credenziali Discord mancanti.')] });
  await interaction.editReply({ embeds: [deployResultEmbed('Ripulito e ridistribuito', result)] });
}

async function deployDryRun(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await deployCommands({ wipe: false, dryRun: true });
  if (!result) return interaction.editReply({ embeds: [errorEmbed('Errore', 'Credenziali Discord mancanti.')] });
  await interaction.editReply({ embeds: [deployResultEmbed('Anteprima (nessuna modifica)', result)] });
}

async function deployRemove(interaction) {
  const raw = interaction.options.getString('nomi');
  const names = raw.split(',').map((n) => n.trim()).filter(Boolean);
  if (!names.length) return error(interaction, 'Dammi almeno un nome di comando.');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { removed } = await removeCommandsByName(names);
  const removedNames = removed.length ? removed.join(', ') : '_(nessuno trovato)_';
  await interaction.editReply({
    embeds: [successEmbed('Rimosso', `Eliminati: **${removedNames}**`)],
  });
}

async function deployUnregister(interaction) {
  const includeGlobal = interaction.options.getBoolean('includi_globali') || false;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { guilds, removed } = await wipeAllGuildCommands({ includeGlobal });

  const lines = [
    `**Guild scansionate:** ${guilds.length}`,
    `**Comandi rimossi:** ${removed}`,
    `**Ambito:** ${includeGlobal ? 'guild + globali' : 'solo guild'}`,
  ];
  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('Deregistrazione completata').setDescription(lines.join('\n')).setTimestamp()],
  });
}

async function deployList(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const report = await listRegisteredCommands();

  const guildLines = report.guilds
    .map((g) => `**${g.name}** (${g.id}): ${g.commands.length ? g.commands.map((c) => `\`${c}\``).join(', ') : '_nessuno_'}`)
    .join('\n');

  const globalLine = report.global.length ? report.global.map((c) => `\`${c}\``).join(', ') : '_nessuno_';

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Comandi registrati')
    .addFields(
      { name: 'Comandi guild', value: guildLines || '_nessuna guild_' },
      { name: 'Comandi globali', value: globalLine },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

function deployResultEmbed(title, diff) {
  const lines = [
    `**Aggiunti:** ${diff.added.length ? diff.added.join(', ') : 'nessuno'}`,
    `**Aggiornati:** ${diff.updated.length ? diff.updated.join(', ') : 'nessuno'}`,
    `**Rimossi:** ${diff.removed.length ? diff.removed.join(', ') : 'nessuno'}`,
    `**Invariati:** ${diff.unchanged.length}`,
    `**Totale distribuito:** ${diff.total}`,
  ];
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Deploy — ${title}`)
    .setDescription(lines.join('\n'))
    .setTimestamp();
}

// --- Helper ---------------------------------------------------------------

function fmtChannel(guild, id) {
  if (!id) return '_(non configurato)_';
  return guild.channels.cache.get(id)?.toString() || `_(mancante: ${id})_`;
}

async function safeCreate(promise, interaction, label) {
  try {
    return await promise;
  } catch (err) {
    logger.error({ err, label }, 'setup admin fallito');
    await interaction.editReply({ embeds: [errorEmbed('Setup fallito', `Impossibile creare ${label}: ${err.message}`)] }).catch(() => {});
    return null;
  }
}

function error(interaction, msg) {
  return interaction.reply({ embeds: [errorEmbed('Errore', msg)], flags: MessageFlags.Ephemeral });
}

module.exports = { data, execute };
