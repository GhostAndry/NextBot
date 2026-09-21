'use strict';

// Context menu "vkick" (voice kick): tasto destro su un membro → Apps → VKick.
// Espelle il membro target dal canale vocale dove si trova, purché chi esegue
// il context menu sia owner di un canale temporaneo che contiene il target.
//
// Differenza dal ban: vkick = solo espulsione. Il target può rientrare
// immediatamente. Per bloccare l'accesso usare /voice ban oppure il context
// menu "vban".
//
// Permessi richiesti:
//   - invoke è owner di un temp voice channel
//   - target si trova nello stesso canale vocale dell'invoke

const { ContextMenuCommandBuilder, ApplicationCommandType, MessageFlags } = require('discord.js');
const { errorEmbed, successEmbed, isOwnerOrAdmin } = require('../../utils/helpers');
const repo = require('../../db/repo');
const voiceStateEvent = require('../../events/voiceStateUpdate');
const logger = require('../../utils/logger');

const data = new ContextMenuCommandBuilder()
  .setName('vkick')
  .setType(ApplicationCommandType.User);

// Risoluzione ownership duplicata (piccola, evita import circolari con
// tempchannel.js che è il command "voice"). L'utente può agire se è owner del
// temp voice OPPURE se ha il flag Administrator (può fare tutto quello che
// farebbe l'owner su QUALSIASI vocale temporanea del guild).
// NB: `reply` è una *funzione* che risponde all'interaction, non una Promise.
async function resolveOwnedVoiceChannel(interaction) {
  const reply = (msg) => interaction.reply({ embeds: [errorEmbed('Errore', msg)], flags: MessageFlags.Ephemeral });

  const voiceChannel = interaction.member.voice?.channel;
  if (!voiceChannel) return { ok: false, reply: () => reply('Entra prima in un canale vocale.') };

  const temp = await repo.getTempChannel(voiceChannel.id);
  if (!temp || temp.kind !== 'voice') {
    return { ok: false, reply: () => reply('Questo canale non è un temp voice.') };
  }
  if (!isOwnerOrAdmin(interaction.member, temp)) {
    return { ok: false, reply: () => reply('Solo il proprietario o un amministratore può usare questo comando.') };
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

  // vkick = solo espulsione. Niente blocked list, niente permissionOverwrites:
  // il target può rientrare liberamente. Per bloccare l'accesso usare vban.
  try {
    await target.voice.setChannel(null, 'voice vkick');
  } catch (err) {
    return interaction.reply({ embeds: [errorEmbed('Errore', err.message)], flags: MessageFlags.Ephemeral });
  }
  await syncSnapshot(interaction, ownerResult.channel);
  return interaction.reply({ embeds: [successEmbed('Espulso', `<@${target.id}> è stato espulso. Può rientrare liberamente.`)], flags: MessageFlags.Ephemeral });
}

module.exports = { data, execute };
