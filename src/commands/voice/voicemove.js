'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const config = require('../../config');
const { errorEmbed, successEmbed } = require('../../utils/helpers');
const logger = require('../../utils/logger');

// Sessioni vocali attive, indicizzate per guildId:userId. Solo in memoria.
const sessions = new Map();

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

  if (!sourceChannel.permissionsFor(me)?.has(PermissionFlagsBits.Connect)) {
    return error(interaction, 'Non posso entrare nel tuo canale.');
  }
  if (!me.permissions.has(PermissionFlagsBits.MoveMembers)) {
    return error(interaction, 'Mi serve il permesso "Sposta membri".');
  }

  const sessionId = makeSessionId(interaction);
  if (sessions.has(sessionId)) return error(interaction, 'Hai già una sessione attiva. Annullala prima.');

  const stagingChannel = await createStagingChannel(interaction.guild, sourceChannel);
  if (!stagingChannel) return error(interaction, 'Impossibile creare il canale di appoggio.');

  try {
    await me.voice.setChannel(sourceChannel, 'voicemove: unisciti alla sorgente');
  } catch (err) {
    await stagingChannel.delete('voicemove: join fallito').catch(() => {});
    return error(interaction, `Impossibile entrare nel tuo canale: ${err.message}`);
  }

  const session = createSession(interaction, sessionId, sourceChannel, stagingChannel);
  sessions.set(sessionId, session);

  await interaction.reply({ embeds: [session.introEmbed()], flags: MessageFlags.Ephemeral });
  registerSessionListeners(session);
}

async function cancelSession(interaction) {
  const sessionId = makeSessionId(interaction);
  const session = sessions.get(sessionId);
  if (!session) return error(interaction, 'Nessuna sessione attiva.');

  await tearDown(session);
  await interaction.reply({ embeds: [successEmbed('Annullato', 'Sessione di voicemove annullata.')], flags: MessageFlags.Ephemeral });
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
    timeoutMs: config.features.voicemove.autoLeaveMs,
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
        ].join('\n'))
        .setFooter({ text: 'Annulla con /voicemove cancel' })
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

  const leftSource = oldState.channelId === session.sourceChannelId;
  const movedSomewhereElse = newState.channelId && newState.channelId !== session.sourceChannelId;
  if (!leftSource || !movedSomewhereElse) return;

  const destination = newState.guild.channels.cache.get(newState.channelId);
  if (!destination) return;
  if (destination.id === session.stagingChannelId) return;

  executeMove(session, destination).catch((err) => logger.error({ err }, 'spostamento voicemove fallito'));
}

async function executeMove(session, destination) {
  if (!session.isActive) return;
  const guild = session.client.guilds.cache.get(session.guildId);
  const sourceChannel = guild.channels.cache.get(session.sourceChannelId);
  if (!sourceChannel) return tearDown(session);

  const staging = guild.channels.cache.get(session.stagingChannelId);
  if (staging?.deletable) staging.delete('voicemove: usato').catch(() => {});

  const members = sourceChannel.members.filter((m) => !m.user.bot);
  let moved = 0;

  for (const [, member] of members) {
    try {
      await member.voice.setChannel(destination, `voicemove di ${session.userId}`);
      moved += 1;
    } catch (err) {
      logger.warn({ err: err.message, user: member.id }, 'spostamento singolo voicemove fallito');
    }
  }

  await notifyUser(session, successEmbed('Voicemove completato', `Spostati ${moved}/${members.size} membri in **${destination.name}**.`));
  await tearDown(session);

  try { await guild.members.me.voice.disconnect('voicemove completato'); } catch (_) {}
}

async function onSessionTimeout(session) {
  if (!session.isActive) return;
  await notifyUser(session, errorEmbed('Voicemove scaduto', 'Nessuno spostamento rilevato entro il timeout.'));
  await tearDown(session);
}

async function tearDown(session) {
  if (!session.isActive) return;
  session.isActive = false;
  sessions.delete(session.id);

  if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
  if (session.voiceListener) session.client.off('voiceStateUpdate', session.voiceListener);

  const guild = session.client.guilds.cache.get(session.guildId);
  if (guild) {
    const staging = guild.channels.cache.get(session.stagingChannelId);
    if (staging?.deletable) staging.delete('voicemove pulizia').catch(() => {});
    try { if (guild.members.me.voice.channel) await guild.members.me.voice.disconnect('voicemove pulizia'); } catch (_) {}
  }
}

async function notifyUser(session, embed) {
  try {
    const user = await session.client.users.fetch(session.userId);
    await user.send({ embeds: [embed] });
  } catch (_) {}
}

// --- Helper ---------------------------------------------------------------

function makeSessionId(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

async function createStagingChannel(guild, sourceChannel) {
  try {
    return await guild.channels.create({
      name: 'voicemove-destinazione',
      type: 2,
      parent: sourceChannel.parent,
      permissionOverwrites: sourceChannel.permissionOverwrites.cache.values(),
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

module.exports = { data, execute };
