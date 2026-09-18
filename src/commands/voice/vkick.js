'use strict';

// Context menu "vkick" (voice kick): tasto destro su un membro → Apps → VKick.
// Caccia il membro target dal canale vocale dove si trova, purché chi esegue
// il context menu sia owner di un canale temporaneo che contiene il target.
//
// Permessi richiesti:
//   - invoke è owner di un temp voice channel
//   - target si trova nello stesso canale vocale dell'invoke
//
// Comportamento identico a /voice kick e al bottone KICK del pannello:
// aggiungiamo il target alla blocked list e lo scolleghiamo dal canale.

const { ContextMenuCommandBuilder, ApplicationCommandType, MessageFlags } = require('discord.js');
const { errorEmbed, successEmbed } = require('../../utils/helpers');
const repo = require('../../db/repo');
const voiceStateEvent = require('../../events/voiceStateUpdate');
const logger = require('../../utils/logger');

const data = new ContextMenuCommandBuilder()
  .setName('vkick')
  .setType(ApplicationCommandType.User);

// Risoluzione ownership duplicata (piccola, evita import circolari con
// tempchannel.js che è il command "voice").
async function resolveOwnedVoiceChannel(interaction) {
  const voiceChannel = interaction.member.voice?.channel;
  if (!voiceChannel) return { ok: false, reply: interaction.reply.bind(interaction, { embeds: [errorEmbed('Errore', 'Entra prima in un canale vocale.')], flags: MessageFlags.Ephemeral }) };

  const temp = await repo.getTempChannel(voiceChannel.id);
  if (!temp || temp.kind !== 'voice') {
    return { ok: false, reply: interaction.reply.bind(interaction, { embeds: [errorEmbed('Errore', 'Questo canale non è un temp voice.')], flags: MessageFlags.Ephemeral }) };
  }
  if (temp.owner_id !== interaction.user.id) {
    return { ok: false, reply: interaction.reply.bind(interaction, { embeds: [errorEmbed('Errore', 'Solo il proprietario può usare questo comando.')], flags: MessageFlags.Ephemeral }) };
  }
  return { ok: true, channel: voiceChannel, temp };
}

async function syncSnapshot(interaction, channel) {
  try {
    const temp = await repo.getTempChannel(channel.id);
    if (temp) await voiceStateEvent.liveSyncVoiceRoom(channel, temp);
  } catch (err) {
    logger.warn({ err: err.message, channel: channel.id }, 'syncSnapshot fallito (vkick)');
  }
}

async function execute(interaction) {
  if (!interaction.guildId) return;

  const target = await interaction.guild.members.fetch(interaction.targetId).catch(() => null);
  if (!target) {
    return interaction.reply({ embeds: [errorEmbed('Utente non trovato', 'Impossibile trovare il membro selezionato.')], flags: MessageFlags.Ephemeral });
  }

  // Verifica che invoke sia in un canale vocale e che sia owner di un temp.
  const ownerResult = await resolveOwnedVoiceChannel(interaction);
  if (!ownerResult.ok) return ownerResult.reply;

  // Il target deve essere nello stesso canale dell'invoke (e quindi anche
  // nello stesso temp voice, dato che invoke è owner di quel temp).
  if (!target.voice?.channel || target.voice.channel.id !== ownerResult.channel.id) {
    return interaction.reply({ embeds: [errorEmbed('Non in canale', 'Questo utente non è nel tuo canale vocale.')], flags: MessageFlags.Ephemeral });
  }
  if (target.id === ownerResult.temp.owner_id) {
    return interaction.reply({ embeds: [errorEmbed('Non valido', 'Non puoi cacciare te stesso.')], flags: MessageFlags.Ephemeral });
  }

  await repo.addBlockedUser(ownerResult.channel.id, target.id);
  try {
    await target.voice.setChannel(null, 'voice vkick');
  } catch (err) {
    return interaction.reply({ embeds: [errorEmbed('Errore', err.message)], flags: MessageFlags.Ephemeral });
  }
  await syncSnapshot(interaction, ownerResult.channel);
  return interaction.reply({ embeds: [successEmbed('Cacciato', `<@${target.id}> è stato cacciato dal tuo canale.`)], flags: MessageFlags.Ephemeral });
}

module.exports = { data, execute };
