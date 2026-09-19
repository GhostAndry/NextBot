'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, MessageFlags } = require('discord.js');
const repo = require('../../db/repo');
const settingsResolver = require('../../services/settings-resolver');
const { successEmbed, errorEmbed } = require('../../utils/helpers');
const logger = require('../../utils/logger');

// /settings è il pannello unico per modificare TUTTO ciò che è salvato nel DB.
// Le opzioni globali restano in config.json (richiedono un restart e non sono
// modificabili runtime). Tutto ciò che è per-guild vive in GuildConfig o in
// GuildConfig.settings (JSON blob per i tunables numerici).
//
// Subcommand groups:
//   show       - mostra la config corrente (tutta o una sezione)
//   autorole   - imposta/disattiva l'autorole al join
//   verify     - imposta/disattiva il ruolo "verificato" per /verify
//   welcome    - imposta/disattiva il canale + messaggio di benvenuto
//   ticket     - categoria, log, max per user, transcript
//   voice      - hub vocale, auto-delete, user limit
//   mod        - canale log, mute role, max warns, warn action
//   levels     - xp min/max, cooldown, canale annunci, toggle annunci
//   reset      - rimuove un override per-guild (torna al valore globale)

const data = new SlashCommandBuilder()
  .setName('settings')
  .setDescription('Configura il bot per questo server')
  .addSubcommand((sc) => sc.setName('show').setDescription('Mostra la configurazione corrente')
    .addStringOption((o) => o.setName('sezione').setDescription('Sezione specifica').setRequired(false)
      .addChoices(
        { name: 'Autorole & benvenuto', value: 'welcome' },
        { name: 'Verifica', value: 'verify' },
        { name: 'Ticket', value: 'ticket' },
        { name: 'Canali temporanei', value: 'voice' },
        { name: 'Moderazione', value: 'mod' },
        { name: 'Livelli', value: 'levels' },
        { name: 'Tunables avanzati', value: 'tunables' },
      )),
  )
  .addSubcommandGroup((group) => group.setName('autorole').setDescription('Gestione autorole al join')
    .addSubcommand((sc) => sc.setName('set').setDescription('Imposta il ruolo assegnato al join').addRoleOption((o) => o.setName('ruolo').setDescription('Ruolo da assegnare').setRequired(true)))
    .addSubcommand((sc) => sc.setName('disable').setDescription('Disattiva l\'autorole'))
    .addSubcommand((sc) => sc.setName('toggle').setDescription('Attiva/disattiva senza rimuovere il ruolo').addBooleanOption((o) => o.setName('attivo').setDescription('true per attivare, false per disattivare').setRequired(true))),
  )
  .addSubcommandGroup((group) => group.setName('verify').setDescription('Sistema di verifica al join')
    .addSubcommand((sc) => sc.setName('role').setDescription('Imposta il ruolo "verificato"').addRoleOption((o) => o.setName('ruolo').setDescription('Ruolo da assegnare dopo la verifica').setRequired(true)))
    .addSubcommand((sc) => sc.setName('disable').setDescription('Disattiva la verifica (rimuovi ruolo)')),
  )
  .addSubcommandGroup((group) => group.setName('welcome').setDescription('Messaggio di benvenuto')
    .addSubcommand((sc) => sc.setName('channel').setDescription('Imposta il canale dove inviare il benvenuto').addChannelOption((o) => o.setName('canale').setDescription('Canale testuale').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((sc) => sc.setName('message').setDescription('Imposta il testo del benvenuto. Placeholder: {user}, {username}, {server}')
      .addStringOption((o) => o.setName('testo').setDescription('Messaggio').setRequired(true).setMaxLength(500)))
    .addSubcommand((sc) => sc.setName('toggle').setDescription('Attiva/disattiva senza rimuovere config').addBooleanOption((o) => o.setName('attivo').setDescription('true per attivare, false per disattivare').setRequired(true)))
    .addSubcommand((sc) => sc.setName('disable').setDescription('Disattiva e rimuovi configurazione')),
  )
  .addSubcommandGroup((group) => group.setName('ticket').setDescription('Configurazione ticket')
    .addSubcommand((sc) => sc.setName('category').setDescription('Imposta la categoria ticket').addChannelOption((o) => o.setName('categoria').addChannelTypes(ChannelType.GuildCategory).setDescription('Categoria esistente').setRequired(true)))
    .addSubcommand((sc) => sc.setName('log').setDescription('Imposta il canale log ticket').addChannelOption((o) => o.setName('canale').addChannelTypes(ChannelType.GuildText).setDescription('Canale esistente').setRequired(true)))
    .addSubcommand((sc) => sc.setName('max').setDescription('Ticket massimi per utente').addIntegerOption((o) => o.setName('quantita').setDescription('1-50').setMinValue(1).setMaxValue(50).setRequired(true)))
    .addSubcommand((sc) => sc.setName('transcript').setDescription('Trascrizione automatica alla chiusura').addBooleanOption((o) => o.setName('attivo').setDescription('true/false').setRequired(true))),
  )
  .addSubcommandGroup((group) => group.setName('voice').setDescription('Canali vocali temporanei')
    .addSubcommand((sc) => sc.setName('hub').setDescription('[legacy] Imposta un singolo hub vocale').addChannelOption((o) => o.setName('canale').addChannelTypes(ChannelType.GuildVoice).setDescription('Canale vocale esistente').setRequired(true)))
    .addSubcommand((sc) => sc.setName('autodelete').setDescription('Secondi prima di eliminare un canale vuoto').addIntegerOption((o) => o.setName('secondi').setDescription('5-3600').setMinValue(5).setMaxValue(3600).setRequired(true)))
    .addSubcommand((sc) => sc.setName('userlimit').setDescription('Limite utenti di default (0=illimitato)').addIntegerOption((o) => o.setName('limite').setDescription('0-99').setMinValue(0).setMaxValue(99).setRequired(true)))
    .addSubcommand((sc) => sc.setName('add').setDescription('Registra un hub vocale che genera temp voice')
      .addChannelOption((o) => o.setName('canale').addChannelTypes(ChannelType.GuildVoice).setDescription('Canale hub da cui si generano i temp voice').setRequired(true))
      .addStringOption((o) => o.setName('nome').setDescription('Nome descrittivo (es. VIP Lounge)').setRequired(false).setMaxLength(50)))
    .addSubcommand((sc) => sc.setName('list').setDescription('Elenca tutti gli hub configurati'))
    .addSubcommand((sc) => sc.setName('remove').setDescription('Rimuovi un hub (i temp voice esistenti resteranno attivi fino a svuotarsi)')
      .addChannelOption((o) => o.setName('canale').addChannelTypes(ChannelType.GuildVoice).setDescription('Canale hub da rimuovere').setRequired(true)))
    .addSubcommand((sc) => sc.setName('default').setDescription('Imposta un hub come predefinito (per riferimento futuro)')
      .addChannelOption((o) => o.setName('canale').addChannelTypes(ChannelType.GuildVoice).setDescription('Canale hub da segnare come default').setRequired(true)))
    .addSubcommand((sc) => sc.setName('rename').setDescription('Rinomina un hub esistente')
      .addChannelOption((o) => o.setName('canale').addChannelTypes(ChannelType.GuildVoice).setDescription('Canale hub da rinominare').setRequired(true))
      .addStringOption((o) => o.setName('nome').setDescription('Nuovo nome').setRequired(true).setMaxLength(50))),
  )
  .addSubcommandGroup((group) => group.setName('mod').setDescription('Configurazione moderazione')
    .addSubcommand((sc) => sc.setName('logchannel').setDescription('Canale log moderazione').addChannelOption((o) => o.setName('canale').addChannelTypes(ChannelType.GuildText).setDescription('Canale esistente').setRequired(true)))
    .addSubcommand((sc) => sc.setName('muterole').setDescription('Ruolo da assegnare per mute').addRoleOption((o) => o.setName('ruolo').setDescription('Ruolo mute (opzionale, toglilo per usare timeout nativo)').setRequired(true)))
    .addSubcommand((sc) => sc.setName('maxwarns').setDescription('Warn massimi prima azione automatica').addIntegerOption((o) => o.setName('quantita').setDescription('1-20').setMinValue(1).setMaxValue(20).setRequired(true)))
    .addSubcommand((sc) => sc.setName('warnaction').setDescription('Azione automatica al raggiungimento max warn')
      .addStringOption((o) => o.setName('azione').setDescription('Tipo di azione').setRequired(true)
        .addChoices(
          { name: 'mute (timeout 1h)', value: 'mute' },
          { name: 'kick', value: 'kick' },
          { name: 'ban', value: 'ban' },
          { name: 'nessuna (solo warn)', value: 'none' },
        ))),
  )
  .addSubcommandGroup((group) => group.setName('levels').setDescription('Sistema livelli')
    .addSubcommand((sc) => sc.setName('xp').setDescription('XP per messaggio (min-max)')
      .addIntegerOption((o) => o.setName('minimo').setDescription('XP minima (1-100)').setMinValue(1).setMaxValue(100).setRequired(true))
      .addIntegerOption((o) => o.setName('massimo').setDescription('XP massima (1-200)').setMinValue(1).setMaxValue(200).setRequired(true)))
    .addSubcommand((sc) => sc.setName('cooldown').setDescription('Cooldown XP in secondi').addIntegerOption((o) => o.setName('secondi').setDescription('0-3600').setMinValue(0).setMaxValue(3600).setRequired(true)))
    .addSubcommand((sc) => sc.setName('announce').setDescription('Canale annuncio level-up').addChannelOption((o) => o.setName('canale').addChannelTypes(ChannelType.GuildText).setDescription('Canale esistente').setRequired(true)))
    .addSubcommand((sc) => sc.setName('toggle').setDescription('Attiva/disattiva annunci level-up').addBooleanOption((o) => o.setName('attivo').setDescription('true/false').setRequired(true))),
  )
  .addSubcommandGroup((group) => group.setName('tunable').setDescription('Override tunables per-guild')
    .addSubcommand((sc) => sc.setName('set').setDescription('Imposta un tunable per-guild')
      .addStringOption((o) => o.setName('chiave').setDescription('Nome del tunable').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('valore').setDescription('Nuovo valore').setRequired(true)))
    .addSubcommand((sc) => sc.setName('reset').setDescription('Rimuovi l\'override per-guild (torna al valore globale)')
      .addStringOption((o) => o.setName('chiave').setDescription('Nome del tunable').setRequired(true).setAutocomplete(true)))
    .addSubcommand((sc) => sc.setName('list').setDescription('Elenca tutti i tunables disponibili e i loro override per-guild')),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function execute(interaction) {
  // Le subcommand top-level (show) hanno group=null.
  const group = interaction.options.getSubcommandGroup();
  const sub = interaction.options.getSubcommand();

  if (!group) {
    if (sub === 'show') return cmdShow(interaction);
    return error(interaction, 'Sottocomando sconosciuto.');
  }

  const handler = HANDLERS[`${group}:${sub}`];
  if (!handler) return error(interaction, 'Sottocomando sconosciuto.');
  return handler(interaction);
}

const HANDLERS = {
  'autorole:set': autoroleSet,
  'autorole:disable': autoroleDisable,
  'autorole:toggle': autoroleToggle,
  'verify:role': verifyRole,
  'verify:disable': verifyDisable,
  'welcome:channel': welcomeChannel,
  'welcome:message': welcomeMessage,
  'welcome:toggle': welcomeToggle,
  'welcome:disable': welcomeDisable,
  'ticket:category': ticketCategory,
  'ticket:log': ticketLog,
  'ticket:max': ticketMax,
  'ticket:transcript': ticketTranscript,
  'voice:hub': voiceHub,
  'voice:autodelete': voiceAutodelete,
  'voice:userlimit': voiceUserLimit,
  'voice:add': voiceAdd,
  'voice:list': voiceList,
  'voice:remove': voiceRemove,
  'voice:default': voiceDefault,
  'voice:rename': voiceRename,
  'mod:logchannel': modLogChannel,
  'mod:muterole': modMuteRole,
  'mod:maxwarns': modMaxWarns,
  'mod:warnaction': modWarnAction,
  'levels:xp': levelsXp,
  'levels:cooldown': levelsCooldown,
  'levels:announce': levelsAnnounce,
  'levels:toggle': levelsToggle,
  'tunable:set': tunableSet,
  'tunable:reset': tunableReset,
  'tunable:list': tunableList,
};

// --- show ------------------------------------------------------------------

async function cmdShow(interaction) {
  const section = interaction.options.getString('sezione');
  const cfg = await repo.getGuildConfig(interaction.guildId);
  const settings = await repo.getGuildSettings(interaction.guildId);

  const sections = {
    welcome: () => showWelcome(interaction, cfg, settings),
    verify: () => showVerify(interaction, cfg, settings),
    ticket: () => showTicket(interaction, cfg, settings),
    voice: () => showVoice(interaction, cfg, settings),
    mod: () => showMod(interaction, cfg, settings),
    levels: () => showLevels(interaction, cfg, settings),
    tunables: () => showTunables(settings),
  };

  const builder = section ? sections[section] : () => showAll(interaction, cfg, settings);
  if (!builder) return error(interaction, 'Sezione non valida.');

  await interaction.reply({ embeds: [await builder()], flags: MessageFlags.Ephemeral });
}

async function showAll(interaction, cfg, settings) {
  const hubs = await repo.listVoiceHubs(interaction.guildId);
  const hubLine = hubs.length
    ? `${hubs.length} hub configurati (vedi \`/settings show sezione:voice\`)`
    : `hub legacy: ${fmtChannel(interaction, cfg.temp_voice_hub_id)}`;
  const overview = [
    'Usa `/settings show sezione:<nome>` per il dettaglio di una singola area.',
    '',
    `🎉 **Autorole & benvenuto** — ruolo: ${fmtRole(cfg.auto_role_id)}, canale welcome: ${fmtChannel(interaction, cfg.welcome_channel_id)}`,
    `✅ **Verifica** — ruolo: ${fmtRole(cfg.verified_role_id)}`,
    `🎫 **Ticket** — categoria: ${fmtChannel(interaction, cfg.ticket_category_id)}, log: ${fmtChannel(interaction, cfg.ticket_log_channel_id)}`,
    `🔊 **Voce** — ${hubLine}`,
    `🛡️ **Moderazione** — log: ${fmtChannel(interaction, cfg.mod_log_channel_id)}, mute role: ${fmtRole(cfg.mute_role_id)}`,
    `📈 **Livelli** — annunci: ${fmtChannel(interaction, cfg.level_announce_channel_id)}`,
    `⚙️ **Tunables sovrascritti** — ${Object.keys(settings).length}`,
  ].join('\n');
  return new EmbedBuilder().setColor(0x5865f2).setTitle('⚙️ Impostazioni server').setDescription(overview).setTimestamp();
}

function showWelcome(interaction, cfg, settings) {
  return new EmbedBuilder().setColor(0x5865f2).setTitle('🎉 Autorole & Benvenuto')
    .addFields(
      { name: 'Ruolo autorole', value: fmtRole(cfg.auto_role_id), inline: true },
      { name: 'Autorole attivo', value: fmtBool(settings.autoroleEnabled, true), inline: true },
      { name: 'Canale benvenuto', value: fmtChannel(interaction, cfg.welcome_channel_id), inline: true },
      { name: 'Benvenuto attivo', value: fmtBool(settings.welcomeEnabled, false), inline: true },
      { name: 'Messaggio', value: cfg.welcome_message ? `\`${cfg.welcome_message}\`` : '_non impostato_' },
    ).setTimestamp();
}

function showVerify(interaction, cfg, settings) {
  return new EmbedBuilder().setColor(0x5865f2).setTitle('✅ Verifica')
    .addFields(
      { name: 'Ruolo verificato', value: fmtRole(cfg.verified_role_id), inline: true },
      { name: 'Verifica attiva', value: fmtBool(settings.verifyEnabled, false), inline: true },
      { name: 'Comando', value: '`/verify` apre un captcha effimero (numero 1-15 o emoji) per ottenere il ruolo.' },
    ).setTimestamp();
}

function showTicket(interaction, cfg, settings) {
  return new EmbedBuilder().setColor(0x5865f2).setTitle('🎫 Ticket')
    .addFields(
      { name: 'Categoria', value: fmtChannel(interaction, cfg.ticket_category_id), inline: true },
      { name: 'Canale log', value: fmtChannel(interaction, cfg.ticket_log_channel_id), inline: true },
      { name: 'Max per utente', value: fmtSetting(settings.maxPerUser, 3), inline: true },
      { name: 'Trascrizione alla chiusura', value: fmtBool(settings.transcriptOnClose, true), inline: true },
    ).setTimestamp();
}

async function showVoice(interaction, cfg, settings) {
  const hubs = await repo.listVoiceHubs(interaction.guildId);
  let hubField;
  if (hubs.length === 0) {
    hubField = { name: 'Hub (legacy)', value: fmtChannel(interaction, cfg.temp_voice_hub_id) };
  } else {
    const lines = hubs.map((h, i) => {
      const ch = interaction.guild.channels.cache.get(h.channel_id);
      const marker = h.is_default ? ' ⭐' : '';
      return `**${i + 1}.** ${h.name}${marker} → ${ch ? ch.toString() : `_(mancante)_`}`;
    });
    hubField = { name: `Hub configurati (${hubs.length})`, value: lines.join('\n') };
  }
  return new EmbedBuilder().setColor(0x5865f2).setTitle('🔊 Canali temporanei')
    .addFields(
      hubField,
      { name: 'Auto-elimina (s)', value: fmtSetting(settings.autoDeleteSecondsEmpty, 30), inline: true },
      { name: 'Limite utenti', value: fmtSetting(settings.defaultUserLimit, 0), inline: true },
    ).setTimestamp();
}

function showMod(interaction, cfg, settings) {
  return new EmbedBuilder().setColor(0x5865f2).setTitle('🛡️ Moderazione')
    .addFields(
      { name: 'Canale log', value: fmtChannel(interaction, cfg.mod_log_channel_id), inline: true },
      { name: 'Ruolo mute', value: fmtRole(cfg.mute_role_id), inline: true },
      { name: 'Max warn', value: fmtSetting(settings.maxWarns, 3), inline: true },
      { name: 'Azione automatica', value: fmtSetting(settings.warnAction, 'mute'), inline: true },
    ).setTimestamp();
}

function showLevels(interaction, cfg, settings) {
  return new EmbedBuilder().setColor(0x5865f2).setTitle('📈 Livelli')
    .addFields(
      { name: 'Canale annunci', value: fmtChannel(interaction, cfg.level_announce_channel_id), inline: true },
      { name: 'XP min', value: fmtSetting(settings.xpMin, 15), inline: true },
      { name: 'XP max', value: fmtSetting(settings.xpMax, 25), inline: true },
      { name: 'Cooldown (s)', value: fmtSetting(settings.cooldownSeconds, 60), inline: true },
      { name: 'Annunci attivi', value: fmtBool(settings.announceLevelUp, true), inline: true },
    ).setTimestamp();
}

function showTunables(settings) {
  const overridden = Object.entries(settings);
  if (overridden.length === 0) {
    return new EmbedBuilder().setColor(0x5865f2).setTitle('⚙️ Tunables')
      .setDescription('Nessun override per-guild. Vengono usati i valori globali da `config.json`.')
      .setTimestamp();
  }
  const lines = overridden.map(([k, v]) => `• \`${k}\` = \`${JSON.stringify(v)}\``);
  return new EmbedBuilder().setColor(0x5865f2).setTitle('⚙️ Tunables (override per-guild)')
    .setDescription(lines.join('\n'))
    .setTimestamp();
}

// --- autorole --------------------------------------------------------------

async function autoroleSet(interaction) {
  const role = interaction.options.getRole('ruolo');
  if (role.managed) return error(interaction, 'Non puoi assegnare un ruolo gestito da un\'integrazione.');
  if (role.id === interaction.guild.id) return error(interaction, 'Non puoi usare @everyone.');

  await repo.setGuildConfig(interaction.guildId, { auto_role_id: role.id });
  await settingsResolver.setSetting(interaction.guildId, 'autoroleEnabled', true);
  await interaction.reply({ embeds: [successEmbed('Autorole impostato', `${role} verrà assegnato ai nuovi membri.`)], flags: MessageFlags.Ephemeral });
}

async function autoroleDisable(interaction) {
  await repo.setGuildConfig(interaction.guildId, { auto_role_id: null });
  await settingsResolver.setSetting(interaction.guildId, 'autoroleEnabled', false);
  await interaction.reply({ embeds: [successEmbed('Autorole disattivato', 'Nessun ruolo sarà più assegnato al join.')], flags: MessageFlags.Ephemeral });
}

async function autoroleToggle(interaction) {
  const active = interaction.options.getBoolean('attivo');
  await settingsResolver.setSetting(interaction.guildId, 'autoroleEnabled', active);
  await interaction.reply({ embeds: [successEmbed('Autorole', active ? 'attivato.' : 'disattivato.')], flags: MessageFlags.Ephemeral });
}

// --- verify ----------------------------------------------------------------

async function verifyRole(interaction) {
  const role = interaction.options.getRole('ruolo');
  if (role.managed) return error(interaction, 'Non puoi usare un ruolo gestito da un\'integrazione.');
  if (role.id === interaction.guildId) return error(interaction, 'Non puoi usare @everyone.');

  await repo.setGuildConfig(interaction.guildId, { verified_role_id: role.id });
  await settingsResolver.setSetting(interaction.guildId, 'verifyEnabled', true);

  // Applica retroattivamente il gating sui canali temp voice già esistenti.
  const voiceEvt = require('../../events/voiceStateUpdate');
  const result = await voiceEvt.enforceVerifiedVisibilityForGuild(interaction.guild, role.id).catch((err) => {
    logger.warn({ err: err.message, guild: interaction.guildId }, 'enforce verify retroattivo fallito');
    return null;
  });

  await interaction.reply({
    embeds: [successEmbed(
      'Verifica attivata',
      `${role} sarà assegnato agli utenti che completano \`/verify\`. I canali vocali temporanei esistenti sono stati aggiornati: ora visibili solo ai verificati (i non verificati attualmente in voce sono stati rimossi).`,
    )],
    flags: MessageFlags.Ephemeral,
  });
}

async function verifyDisable(interaction) {
  await repo.setGuildConfig(interaction.guildId, { verified_role_id: null });
  await settingsResolver.setSetting(interaction.guildId, 'verifyEnabled', false);
  await interaction.reply({ embeds: [successEmbed('Verifica disattivata', 'Sistema di verifica rimosso. I vocali temporanei tornano accessibili a tutti.')], flags: MessageFlags.Ephemeral });
}

// --- welcome ---------------------------------------------------------------

async function welcomeChannel(interaction) {
  const channel = interaction.options.getChannel('canale');
  await repo.setGuildConfig(interaction.guildId, { welcome_channel_id: channel.id });
  await settingsResolver.setSetting(interaction.guildId, 'welcomeEnabled', true);
  await interaction.reply({ embeds: [successEmbed('Canale benvenuto', `Impostato su ${channel}.`)], flags: MessageFlags.Ephemeral });
}

async function welcomeMessage(interaction) {
  const text = interaction.options.getString('testo');
  await repo.setGuildConfig(interaction.guildId, { welcome_message: text });
  await interaction.reply({ embeds: [successEmbed('Messaggio aggiornato', `Anteprima: ${text.replaceAll('{user}', `<@${interaction.user.id}>`).replaceAll('{server}', interaction.guild.name)}`)], flags: MessageFlags.Ephemeral });
}

async function welcomeToggle(interaction) {
  const active = interaction.options.getBoolean('attivo');
  await settingsResolver.setSetting(interaction.guildId, 'welcomeEnabled', active);
  await interaction.reply({ embeds: [successEmbed('Benvenuto', active ? 'attivato.' : 'disattivato.')], flags: MessageFlags.Ephemeral });
}

async function welcomeDisable(interaction) {
  await repo.setGuildConfig(interaction.guildId, { welcome_channel_id: null, welcome_message: null });
  await settingsResolver.setSetting(interaction.guildId, 'welcomeEnabled', false);
  await interaction.reply({ embeds: [successEmbed('Benvenuto disattivato', 'Tutto ripulito.')], flags: MessageFlags.Ephemeral });
}

// --- ticket ----------------------------------------------------------------

async function ticketCategory(interaction) {
  const channel = interaction.options.getChannel('categoria');
  if (channel.type !== ChannelType.GuildCategory) return error(interaction, 'Scegli una categoria.');
  await repo.setGuildConfig(interaction.guildId, { ticket_category_id: channel.id });
  await interaction.reply({ embeds: [successEmbed('Categoria ticket', channel.toString())], flags: MessageFlags.Ephemeral });
}

async function ticketLog(interaction) {
  const channel = interaction.options.getChannel('canale');
  if (channel.type !== ChannelType.GuildText) return error(interaction, 'Scegli un canale testuale.');
  await repo.setGuildConfig(interaction.guildId, { ticket_log_channel_id: channel.id });
  await interaction.reply({ embeds: [successEmbed('Log ticket', channel.toString())], flags: MessageFlags.Ephemeral });
}

async function ticketMax(interaction) {
  const value = interaction.options.getInteger('quantita');
  await settingsResolver.setSetting(interaction.guildId, 'maxPerUser', value);
  await interaction.reply({ embeds: [successEmbed('Max ticket', `Massimo per utente: ${value}.`)], flags: MessageFlags.Ephemeral });
}

async function ticketTranscript(interaction) {
  const value = interaction.options.getBoolean('attivo');
  await settingsResolver.setSetting(interaction.guildId, 'transcriptOnClose', value);
  await interaction.reply({ embeds: [successEmbed('Trascrizione', value ? 'attiva.' : 'disattivata.')], flags: MessageFlags.Ephemeral });
}

// --- voice -----------------------------------------------------------------

async function voiceHub(interaction) {
  const channel = interaction.options.getChannel('canale');
  if (channel.type !== ChannelType.GuildVoice) return error(interaction, 'Scegli un canale vocale.');
  await repo.setGuildConfig(interaction.guildId, { temp_voice_hub_id: channel.id });
  await interaction.reply({ embeds: [successEmbed('Hub vocale', channel.toString())], flags: MessageFlags.Ephemeral });
}

async function voiceAutodelete(interaction) {
  const value = interaction.options.getInteger('secondi');
  await settingsResolver.setSetting(interaction.guildId, 'autoDeleteSecondsEmpty', value);
  await interaction.reply({ embeds: [successEmbed('Auto-elimina', `I canali vuoti saranno eliminati dopo ${value}s.`)], flags: MessageFlags.Ephemeral });
}

async function voiceUserLimit(interaction) {
  const value = interaction.options.getInteger('limite');
  await settingsResolver.setSetting(interaction.guildId, 'defaultUserLimit', value);
  await interaction.reply({ embeds: [successEmbed('Limite utenti', value === 0 ? 'illimitato.' : `${value} utenti.`)], flags: MessageFlags.Ephemeral });
}

// --- Multi-hub -------------------------------------------------------------

async function voiceHub(interaction) {
  // Legacy: aggiunge il canale come hub. Per compatibilità con il vecchio flusso
  // monohub, lo aggiungiamo anche in VoiceHub se non esiste già.
  const channel = interaction.options.getChannel('canale');
  if (channel.type !== ChannelType.GuildVoice) return error(interaction, 'Scegli un canale vocale.');

  await repo.setGuildConfig(interaction.guildId, { temp_voice_hub_id: channel.id });
  const existing = await repo.getVoiceHubByChannel(channel.id);
  if (!existing) {
    await repo.addVoiceHub(interaction.guildId, channel.id, 'Hub', channel.parentId);
    const evt = require('../../events/voiceStateUpdate');
    evt.invalidateHubCache(interaction.guildId);
  }
  await interaction.reply({ embeds: [successEmbed('Hub vocale', `${channel} è ora un hub temp voice. Usa \`/settings voice list\` per vederli tutti.`)], flags: MessageFlags.Ephemeral });
}

async function voiceAdd(interaction) {
  const channel = interaction.options.getChannel('canale');
  const name = interaction.options.getString('nome') || 'Hub';
  if (channel.type !== ChannelType.GuildVoice) return error(interaction, 'Scegli un canale vocale.');

  const existing = await repo.getVoiceHubByChannel(channel.id);
  if (existing) return error(interaction, `${channel} è già un hub temp voice.`);

  await repo.addVoiceHub(interaction.guildId, channel.id, name, channel.parentId);
  const evt = require('../../events/voiceStateUpdate');
  evt.invalidateHubCache(interaction.guildId);
  await interaction.reply({ embeds: [successEmbed('Hub aggiunto', `${channel} è ora un hub temp voice (${name}). Chi vi entra crea un canale 👑 sotto la stessa categoria.`)], flags: MessageFlags.Ephemeral });
}

async function voiceList(interaction) {
  const hubs = await repo.listVoiceHubs(interaction.guildId);
  if (hubs.length === 0) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🔊 Hub temp voice').setDescription('Nessun hub configurato. Usa `/settings voice add` per aggiungerne uno.').setTimestamp()],
      flags: MessageFlags.Ephemeral,
    });
  }
  const lines = await Promise.all(hubs.map(async (h, i) => {
    const channel = interaction.guild.channels.cache.get(h.channel_id);
    const marker = h.is_default ? ' ⭐ (predefinito)' : '';
    const live = channel ? channel.toString() : `_(mancante: ${h.channel_id})_`;
    const activeCount = await countActiveChannelsForHub(interaction.guildId, h.channel_id);
    return `**${i + 1}.** ${h.name}${marker} → ${live} — canali attivi: ${activeCount}`;
  }));
  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🔊 Hub temp voice').setDescription(lines.join('\n')).setTimestamp()],
    flags: MessageFlags.Ephemeral,
  });
}

async function countActiveChannelsForHub(guildId, hubChannelId) {
  const voiceTracker = require('../../services/voice-state-tracker');
  return voiceTracker.listByHub(guildId, hubChannelId).length;
}

async function voiceRemove(interaction) {
  const channel = interaction.options.getChannel('canale');
  const existing = await repo.getVoiceHubByChannel(channel.id);
  if (!existing) return error(interaction, `${channel} non è un hub configurato.`);

  await repo.removeVoiceHub(channel.id);
  const evt = require('../../events/voiceStateUpdate');
  evt.invalidateHubCache(interaction.guildId);
  await interaction.reply({ embeds: [successEmbed('Hub rimosso', `${channel} non genera più temp voice. I canali già creati restano attivi fino a svuotarsi.`)], flags: MessageFlags.Ephemeral });
}

async function voiceDefault(interaction) {
  const channel = interaction.options.getChannel('canale');
  const existing = await repo.getVoiceHubByChannel(channel.id);
  if (!existing) return error(interaction, `${channel} non è un hub configurato.`);

  await repo.setDefaultVoiceHub(channel.id);
  await interaction.reply({ embeds: [successEmbed('Hub predefinito', `${channel} è ora l'hub predefinito.`)], flags: MessageFlags.Ephemeral });
}

async function voiceRename(interaction) {
  const channel = interaction.options.getChannel('canale');
  const name = interaction.options.getString('nome');
  const existing = await repo.getVoiceHubByChannel(channel.id);
  if (!existing) return error(interaction, `${channel} non è un hub configurato.`);

  await repo.renameVoiceHub(channel.id, name);
  await interaction.reply({ embeds: [successEmbed('Hub rinominato', `Ora si chiama **${name}**.`)], flags: MessageFlags.Ephemeral });
}

// --- mod -------------------------------------------------------------------

async function modLogChannel(interaction) {
  const channel = interaction.options.getChannel('canale');
  if (channel.type !== ChannelType.GuildText) return error(interaction, 'Scegli un canale testuale.');
  await repo.setGuildConfig(interaction.guildId, { mod_log_channel_id: channel.id });
  await interaction.reply({ embeds: [successEmbed('Log moderazione', channel.toString())], flags: MessageFlags.Ephemeral });
}

async function modMuteRole(interaction) {
  const role = interaction.options.getRole('ruolo');
  await repo.setGuildConfig(interaction.guildId, { mute_role_id: role.id });
  await interaction.reply({ embeds: [successEmbed('Ruolo mute', role.toString())], flags: MessageFlags.Ephemeral });
}

async function modMaxWarns(interaction) {
  const value = interaction.options.getInteger('quantita');
  await settingsResolver.setSetting(interaction.guildId, 'maxWarns', value);
  await interaction.reply({ embeds: [successEmbed('Max warn', `${value} warn prima dell'azione automatica.`)], flags: MessageFlags.Ephemeral });
}

async function modWarnAction(interaction) {
  const value = interaction.options.getString('azione');
  await settingsResolver.setSetting(interaction.guildId, 'warnAction', value);
  await interaction.reply({ embeds: [successEmbed('Azione automatica', `Al raggiungimento dei warn il bot eseguirà: **${value}**.`)], flags: MessageFlags.Ephemeral });
}

// --- levels ----------------------------------------------------------------

async function levelsXp(interaction) {
  const min = interaction.options.getInteger('minimo');
  const max = interaction.options.getInteger('massimo');
  if (min > max) return error(interaction, 'Il minimo non può essere maggiore del massimo.');
  await settingsResolver.setSetting(interaction.guildId, 'xpMin', min);
  await settingsResolver.setSetting(interaction.guildId, 'xpMax', max);
  await interaction.reply({ embeds: [successEmbed('XP per messaggio', `Range aggiornato: ${min}–${max}.`)], flags: MessageFlags.Ephemeral });
}

async function levelsCooldown(interaction) {
  const value = interaction.options.getInteger('secondi');
  await settingsResolver.setSetting(interaction.guildId, 'cooldownSeconds', value);
  await interaction.reply({ embeds: [successEmbed('Cooldown XP', `${value} secondi.`)], flags: MessageFlags.Ephemeral });
}

async function levelsAnnounce(interaction) {
  const channel = interaction.options.getChannel('canale');
  if (channel.type !== ChannelType.GuildText) return error(interaction, 'Scegli un canale testuale.');
  await repo.setGuildConfig(interaction.guildId, { level_announce_channel_id: channel.id });
  await interaction.reply({ embeds: [successEmbed('Canale annunci livelli', channel.toString())], flags: MessageFlags.Ephemeral });
}

async function levelsToggle(interaction) {
  const value = interaction.options.getBoolean('attivo');
  await settingsResolver.setSetting(interaction.guildId, 'announceLevelUp', value);
  await interaction.reply({ embeds: [successEmbed('Annunci level-up', value ? 'attivi.' : 'disattivati.')], flags: MessageFlags.Ephemeral });
}

// --- tunable (raw key/value) ----------------------------------------------

async function tunableSet(interaction) {
  const key = interaction.options.getString('chiave').trim();
  const raw = interaction.options.getString('valore');

  const meta = settingsResolver.getKnownMeta(key);
  if (!meta) return error(interaction, `Chiave \`${key}\` non riconosciuta. Usa \`/settings tunable list\`.`);

  const validation = settingsResolver.validateValue(meta, raw);
  if (!validation.ok) return error(interaction, validation.error);

  await settingsResolver.setSetting(interaction.guildId, key, validation.value);
  await interaction.reply({ embeds: [successEmbed('Tunable aggiornato', `\`${key}\` = \`${JSON.stringify(validation.value)}\`.`)], flags: MessageFlags.Ephemeral });
}

async function tunableReset(interaction) {
  const key = interaction.options.getString('chiave').trim();
  if (!settingsResolver.isKnownKey(key)) return error(interaction, `Chiave \`${key}\` non riconosciuta.`);

  const removed = await settingsResolver.resetSetting(interaction.guildId, key);
  if (!removed) return error(interaction, `Nessun override per \`${key}\` in questa guild.`);
  await interaction.reply({ embeds: [successEmbed('Tunable resettato', `\`${key}\` tornerà al valore globale.`)], flags: MessageFlags.Ephemeral });
}

async function tunableList(interaction) {
  const settings = await repo.getGuildSettings(interaction.guildId);
  const entries = settingsResolver.listKeys();
  const lines = entries.map(({ key, label, type, min, max, values }) => {
    const override = settings[key];
    const marker = override !== undefined ? ` → \`${JSON.stringify(override)}\`` : '';
    const meta = type === 'int' ? ` (${min ?? '?'}–${max ?? '?'})` : type === 'enum' ? ` (${(values || []).join('/')})` : '';
    return `• \`${key}\`${meta} — ${label}${marker}`;
  });
  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('⚙️ Tunables disponibili').setDescription(lines.join('\n')).setTimestamp()],
    flags: MessageFlags.Ephemeral,
  });
}

// --- Autocomplete per tunable ---------------------------------------------

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const entries = settingsResolver.listKeys();
  const choices = entries
    .filter(({ key, label }) => key.toLowerCase().includes(focused) || label.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(({ key, label }) => ({ name: `${key} — ${label}`.slice(0, 100), value: key }));
  await interaction.respond(choices);
}

// --- helper ---------------------------------------------------------------

function fmtChannel(interaction, id) {
  if (!id) return '_(non impostato)_';
  const ch = interaction.guild.channels.cache.get(id);
  return ch ? ch.toString() : `_(mancante: ${id})_`;
}

function fmtRole(id) {
  if (!id) return '_(non impostato)_';
  return `<@&${id}>`;
}

function fmtBool(value, fallback) {
  const effective = value === undefined ? fallback : value;
  return effective ? '✅ attivo' : '❌ disattivato';
}

function fmtSetting(value, fallback) {
  return value === undefined ? `${fallback} _(globale)_` : `${value} _(override)_`;
}

function error(interaction, msg) {
  return interaction.reply({ embeds: [errorEmbed('Errore', msg)], flags: MessageFlags.Ephemeral });
}

module.exports = { data, execute, autocomplete };
