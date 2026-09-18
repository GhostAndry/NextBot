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
  .setDescription('Sposta tutti i membri del tuo canale vocale nella destinazione che scegli')
  .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers);

// --- Dispatcher -----------------------------------------------------------

async function execute(interaction) {
  return startSession(interaction);
}

// --- Sottocomandi ---------------------------------------------------------

async function startSession(interaction) {
  if (!config.features.voicemove.enabled) return disabled(interaction);

  const member = interaction.member;
  const voice = member?.voice;
  if (!voice?.channel) return error(interaction, 'Entra prima in un canale vocale.');

  const sourceChannel = voice.channel;
  const me = interaction.guild.members.me;

  // Permessi necessari: bot può vedere/entrare nel canale sorgente e può spostare.
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

  const sessionId = makeSessionId(interaction);
  if (sessions.has(sessionId)) return error(interaction, 'Hai già una sessione attiva. /voicemove per annullare.');

  // Defer: l'azione di entrare nel canale potrebbe richiedere >3s su guild grandi.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Entra nel canale sorgente.
  try {
    await me.voice.setChannel(sourceChannel, 'voicemove: pronto a spostare');
  } catch (err) {
    return interaction.editReply({ embeds: [errorEmbed('Errore', `Impossibile entrare nel tuo canale: ${err.message}`)] });
  }

  const session = createSession(interaction, sessionId, sourceChannel);
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

function createSession(interaction, sessionId, sourceChannel) {
  return {
    id: sessionId,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    client: interaction.client,
    sourceChannelId: sourceChannel.id,
    botMemberId: interaction.guild.members.me.id,
    timeoutMs: config.features.voicemove.autoLeaveMs || DEFAULT_TIMEOUT_MS,
    timeoutHandle: null,
    voiceListener: null,
    isActive: true,
    // Snapshot dei membri attuali nel canale sorgente al momento dell'avvio.
    // Quando il bot viene spostato, spostiamo esattamente questi utenti.
    sourceMembers: Array.from(sourceChannel.members.filter((m) => !m.user.bot).keys()),
    introEmbed() {
      const { EmbedBuilder } = require('discord.js');
      return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Voicemove attivo')
        .setDescription([
          `Sono entrato in **${sourceChannel.name}**.`,
          `Trascinami (il bot) nel canale di destinazione.`,
          `Quando mi sposti, tutti i membri presenti in **${sourceChannel.name}** verranno spostati lì.`,
          `Esco automaticamente dopo ${Math.round(this.timeoutMs / 1000)}s di inattività.`,
          `Rifai \`/voicemove\` per annullare.`,
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
  if (!session.isActive) return;

  // Trigger: il bot è stato mosso FUORI dal canale sorgente verso un altro canale
  // (utente lo trascina) o disconnesso del tutto.
  const wasInSource = oldState.channelId === session.sourceChannelId;
  if (!wasInSource) return;

  if (!newState.channelId) {
    // Bot disconnesso: tear down silenzioso.
    tearDown(session, { silent: true }).catch(() => {});
    return;
  }

  const destination = newState.guild.channels.cache.get(newState.channelId);
  if (!destination) return;
  if (destination.id === session.sourceChannelId) return; // spostato nello stesso canale, ignora

  executeMove(session, destination).catch((err) => logger.error({ err }, 'spostamento voicemove fallito'));
}

async function executeMove(session, destination) {
  if (!session.isActive) return;
  const guild = session.client.guilds.cache.get(session.guildId);
  if (!guild) return tearDown(session, { silent: true });
  const sourceChannel = guild.channels.cache.get(session.sourceChannelId);
  if (!sourceChannel) return tearDown(session, { silent: true });

  // Prendi TUTTI i membri attuali nel canale sorgente (inclusi quelli entrati
  // dopo l'avvio della sessione, purché non siano bot). Se sono usciti nel
  // frattempo, la move fallirà con "not in voice" e li ignoriamo.
  const memberIds = Array.from(sourceChannel.members.keys()).filter((id) => id !== session.botMemberId);
  let moved = 0;
  let skipped = 0;

  for (const memberId of memberIds) {
    try {
      const member = await guild.members.fetch(memberId).catch(() => null);
      if (!member || !member.voice.channel || member.voice.channel.id !== session.sourceChannelId) {
        // È uscito dal sorgente nel frattempo: skip silenzioso.
        skipped += 1;
        continue;
      }
      if (!member.movable) {
        skipped += 1;
        continue;
      }
      await member.voice.setChannel(destination, `voicemove di ${session.userId}`);
      moved += 1;
    } catch (err) {
      logger.warn({ err: err.message, user: memberId }, 'spostamento singolo voicemove fallito');
      skipped += 1;
    }
  }

  const lines = [
    `Spostati **${moved}/${memberIds.length}** membri in **${destination.name}**.`,
  ];
  if (skipped > 0) lines.push(`⚠️ ${skipped} non spostati (usciti dal canale o ruolo superiore al bot).`);

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
  // Disconnette il bot se è ancora in vocale. Niente staging da pulire.
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

function disabled(interaction) {
  return interaction.reply({ embeds: [errorEmbed('Disabilitato', 'Il voicemove è disabilitato.')], flags: MessageFlags.Ephemeral });
}

function error(interaction, msg) {
  return interaction.reply({ embeds: [errorEmbed('Errore', msg)], flags: MessageFlags.Ephemeral });
}

module.exports = { data, execute, purgeGuild, purgeMember };
