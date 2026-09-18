'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const config = require('../../config');
const { errorEmbed, successEmbed } = require('../../utils/helpers');
const logger = require('../../utils/logger');

// Sessioni vocali attive, indicizzate per guildId:userId. Solo in memoria.
// NB: vengono ripulite su guildDelete, guildMemberRemove e al bot logout.
const sessions = new Map();

// Timeout di default (ms) per una sessione di voicemove. Configurabile via
// config.features.voicemove.autoLeaveMs.
const DEFAULT_TIMEOUT_MS = 30_000;

// --- Definizione comando ---------------------------------------------------

const data = new SlashCommandBuilder()
  .setName('voicemove')
  .setDescription('Sposta tutti dal tuo canale vocale a un altro tramite il bot')
  .addSubcommand((sc) => sc.setName('start').setDescription('Avvia una sessione di voicemove'))
  .addSubcommand((sc) => sc.setName('cancel').setDescription('Annulla la sessione attiva'))
  .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers);

// --- Dispatcher -----------------------------------------------------------

async function execute(interaction) {
  const handler = SUBCOMMAND_HANDLERS[interaction.options.getSubcommand()];
  if (!handler) return error(interaction, 'Sottocomando sconosciuto.');
  return handler(interaction);
}

const SUBCOMMAND_HANDLERS = {
  start: startSession,
  cancel: cancelSession,
};

// --- Sottocomandi ---------------------------------------------------------

async function startSession(interaction) {
  if (!config.features.voicemove.enabled) return disabled(interaction);

  const member = interaction.member;
  const voice = member?.voice;
  if (!voice?.channel) return error(interaction, 'Entra prima in un canale vocale.');

  const sourceChannel = voice.channel;
  const me = interaction.guild.members.me;

  // Permessi necessari sia sul sorgente sia sulla categoria (per staging).
  const srcPerms = sourceChannel.permissionsFor(me);
  if (!srcPerms?.has(PermissionFlagsBits.Connect)) {
    return error(interaction, 'Non posso entrare nel tuo canale.');
  }
  if (!srcPerms?.has(PermissionFlagsBits.ViewChannel)) {
    return error(interaction, 'Non posso vedere il tuo canale.');
  }
  if (!me.permissions.has(PermissionFlagsBits.MoveMembers)) {
    return error(interaction, 'Mi serve il permesso "Sposta membri".');
  }
  // Sanity check: i membri sorgenti devono essere movibili dal bot (ruoli).
  const nonMovable = sourceChannel.members.filter((m) => !m.user.bot && !m.movable).size;
  if (nonMovable > 0) {
    return error(interaction, `${nonMovable} membro/i non movibili nel canale (ruolo superiore al bot).`);
  }

  const sessionId = makeSessionId(interaction);
  if (sessions.has(sessionId)) return error(interaction, 'Hai già una sessione attiva. Annullala prima.');

  // Defer la reply prima di iniziare lavoro pesante: se la creazione dello
  // staging fallisce dopo 3s, l'utente vede un messaggio di errore invece di
  // "Unknown interaction".
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const stagingChannel = await createStagingChannel(interaction.guild, sourceChannel);
  if (!stagingChannel) {
    return interaction.editReply({ embeds: [errorEmbed('Errore', 'Impossibile creare il canale di appoggio. Controlla i permessi del bot.')] });
  }

  try {
    await me.voice.setChannel(sourceChannel, 'voicemove: unisciti alla sorgente');
  } catch (err) {
    await stagingChannel.delete('voicemove: join fallito').catch(() => {});
    return interaction.editReply({ embeds: [errorEmbed('Errore', `Impossibile entrare nel tuo canale: ${err.message}`)] });
  }

  const session = createSession(interaction, sessionId, sourceChannel, stagingChannel);
  sessions.set(sessionId, session);

  await interaction.editReply({ embeds: [session.introEmbed()] });
  registerSessionListeners(session);
}

async function cancelSession(interaction) {
  const sessionId = makeSessionId(interaction);
  const session = sessions.get(sessionId);
  if (!session) return error(interaction, 'Nessuna sessione attiva.');

  await tearDown(session);
  return interaction.reply({ embeds: [successEmbed('Annullato', 'Sessione di voicemove annullata.')], flags: MessageFlags.Ephemeral });
}

// --- Ciclo di vita della sessione -----------------------------------------

function createSession(interaction, sessionId, sourceChannel, stagingChannel) {
  return {
    id: sessionId,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    client: interaction.client,
    sourceChannelId: sourceChannel.id,
    stagingChannelId: stagingChannel.id,
    botMemberId: interaction.guild.members.me.id,
    timeoutMs: config.features.voicemove.autoLeaveMs || DEFAULT_TIMEOUT_MS,
    timeoutHandle: null,
    voiceListener: null,
    isActive: true,
    introEmbed() {
      const { EmbedBuilder } = require('discord.js');
      return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Voicemove attivo')
        .setDescription([
          `Sono entrato in **${sourceChannel.name}**.`,
          `Trascinami (il bot) nel canale di destinazione.`,
          `Tutti quelli in **${sourceChannel.name}** verranno spostati lì.`,
          `Esco automaticamente dopo ${Math.round(this.timeoutMs / 1000)}s di inattività.`,
          `Annulla con \`/voicemove cancel\`.`,
        ].join('\n'))
        .setFooter({ text: `Sessione di ${interaction.user.tag}` })
        .setTimestamp();
    },
  };
}

function registerSessionListeners(session) {
  session.voiceListener = (oldState, newState) => onVoiceStateUpdate(session, oldState, newState);
  session.client.on('voiceStateUpdate', session.voiceListener);
  session.timeoutHandle = setTimeout(() => onSessionTimeout(session), session.timeoutMs);
}

function onVoiceStateUpdate(session, oldState, newState) {
  if (oldState.id !== session.botMemberId) return;

  // Non processare se la sessione è già stata chiusa
  if (!session.isActive) return;

  // Reazioni a:
  //   - il bot viene mosso FUORI dal canale sorgente in un altro canale utente
  //   - il bot viene disconnesso completamente (channelId = null)
  const wasInSource = oldState.channelId === session.sourceChannelId;
  const wasInStaging = oldState.channelId === session.stagingChannelId;
  const wentToUserChannel = newState.channelId && newState.channelId !== session.stagingChannelId;
  const disconnected = !newState.channelId;

  if (!wasInSource && !wasInStaging) return;
  if (!wentToUserChannel && !disconnected) return;

  const destination = disconnected ? null : newState.guild.channels.cache.get(newState.channelId);
  // Ignora se la destinazione è uguale al source (movimento nullo)
  if (destination && destination.id === session.sourceChannelId) return;

  executeMove(session, destination).catch((err) => logger.error({ err }, 'spostamento voicemove fallito'));
}

async function executeMove(session, destination) {
  if (!session.isActive) return;
  if (!destination) {
    // Bot disconnesso: tear down senza error.
    return tearDown(session, { silent: true });
  }

  const guild = session.client.guilds.cache.get(session.guildId);
  if (!guild) return tearDown(session, { silent: true });
  const sourceChannel = guild.channels.cache.get(session.sourceChannelId);
  if (!sourceChannel) return tearDown(session, { silent: true });

  // Elimina lo staging: il bot è già partito, lo staging non serve più.
  const staging = guild.channels.cache.get(session.stagingChannelId);
  if (staging?.deletable) staging.delete('voicemove: usato').catch(() => {});

  // Filtra i membri del sorgente (escludi bot e membri non più nel canale).
  const members = sourceChannel.members.filter((m) => !m.user.bot && m.movable);
  let moved = 0;
  let skipped = 0;
  const failures = [];

  for (const [, member] of members) {
    try {
      await member.voice.setChannel(destination, `voicemove di ${session.userId}`);
      moved += 1;
    } catch (err) {
      // Discord API errors: ruolo troppo alto, channel pieno, ecc.
      failures.push({ userId: member.id, reason: err.message });
      skipped += 1;
    }
  }

  const lines = [
    `Spostati **${moved}/${members.size}** membri in **${destination.name}**.`,
  ];
  if (skipped > 0) lines.push(`❌ ${skipped} non movibili (ruolo superiore al bot o errore API).`);
  if (failures.length > 0 && failures.length <= 5) {
    lines.push('Errori: ' + failures.map((f) => `<@${f.userId}>`).join(', '));
  }

  await notifyUser(session, successEmbed('Voicemove completato', lines.join('\n')));
  await tearDown(session);

  try { if (guild.members.me.voice.channel) await guild.members.me.voice.disconnect('voicemove completato'); } catch (_) {}
}

async function onSessionTimeout(session) {
  if (!session.isActive) return;
  await notifyUser(session, errorEmbed('Voicemove scaduto', 'Nessuno spostamento rilevato entro il timeout.'));
  await tearDown(session);
}

async function tearDown(session, { silent = false } = {}) {
  if (!session.isActive) return;
  session.isActive = false;
  sessions.delete(session.id);

  if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
  if (session.voiceListener) session.client.off('voiceStateUpdate', session.voiceListener);

  const guild = session.client.guilds.cache.get(session.guildId);
  if (!guild) return;
  if (!silent) {
    const staging = guild.channels.cache.get(session.stagingChannelId);
    if (staging?.deletable) staging.delete('voicemove pulizia').catch(() => {});
  }
  try { if (guild.members.me.voice.channel) await guild.members.me.voice.disconnect('voicemove pulizia'); } catch (_) {}
}

async function notifyUser(session, embed) {
  try {
    const user = await session.client.users.fetch(session.userId);
    await user.send({ embeds: [embed] });
  } catch (_) {
    // DM chiusi, fallisce silenziosamente. Loggato a livello debug per diagnosi.
    logger.debug({ userId: session.userId }, 'voicemove: notifica DM fallita');
  }
}

// --- Pulizia reattiva -----------------------------------------------------

// Quando il bot lascia un guild, butta tutte le sessioni di quel guild.
function purgeGuild(guildId) {
  for (const [id, s] of sessions) {
    if (s.guildId === guildId) {
      if (s.timeoutHandle) clearTimeout(s.timeoutHandle);
      if (s.voiceListener) s.client.off('voiceStateUpdate', s.voiceListener);
      sessions.delete(id);
    }
  }
}

// Quando un membro lascia il guild, elimina la sua sessione.
function purgeMember(guildId, userId) {
  const id = `${guildId}:${userId}`;
  const s = sessions.get(id);
  if (!s) return;
  if (s.timeoutHandle) clearTimeout(s.timeoutHandle);
  if (s.voiceListener) s.client.off('voiceStateUpdate', s.voiceListener);
  sessions.delete(id);
}

// --- Helper ---------------------------------------------------------------

function makeSessionId(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

async function createStagingChannel(guild, sourceChannel) {
  try {
    const me = guild.members.me;
    // Permesso di base: nessuno vede lo staging tranne il bot e il source owner.
    // La copia dei permissionOverwrites del source è comoda ma pericolosa:
    // meglio partire con un set minimo e aggiungere solo i permessi minimi
    // richiesti (Connect + ViewChannel per il source owner).
    const baseOverwrites = [
      {
        id: guild.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: me.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak,
          PermissionFlagsBits.MoveMembers,
          PermissionFlagsBits.ManageChannels,
        ],
      },
    ];

    return await guild.channels.create({
      name: 'voicemove-destinazione',
      type: 2,
      parent: sourceChannel.parent,
      permissionOverwrites: baseOverwrites,
      reason: 'voicemove staging',
    });
  } catch (err) {
    logger.error({ err }, 'creazione canale di appoggio fallita');
    return null;
  }
}

function disabled(interaction) {
  return interaction.reply({ embeds: [errorEmbed('Disabilitato', 'Il voicemove è disabilitato.')], flags: MessageFlags.Ephemeral });
}

function error(interaction, msg) {
  return interaction.reply({ embeds: [errorEmbed('Errore', msg)], flags: MessageFlags.Ephemeral });
}

module.exports = { data, execute, purgeGuild, purgeMember };
