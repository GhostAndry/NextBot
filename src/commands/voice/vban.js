'use strict';

// Context menu "vban" (voice ban): tasto destro su un membro → Apps → VBan.
// Bandisce il target dal canale vocale dove si trova, purché chi esegue il
// context menu sia owner di un canale temporaneo che contiene il target.
//
// Effetti:
//   - aggiunge il target alla lista banned del canale (persiste nello snapshot
//     VoiceRoom anche dopo la cancellazione del canale)
//   - imposta permissionOverwrites Connect:false sul target (difesa in
//     profondità a livello Discord)
//   - scollega il target dal canale se attualmente connesso
//   - al prossimo rientro, voiceStateUpdate lo kicca automaticamente
//
// Per riammettere: /voice unban oppure il bottone Unban del pannello.

const { ContextMenuCommandBuilder, ApplicationCommandType, MessageFlags } = require('discord.js');
const { errorEmbed, successEmbed, isOwnerOrAdmin } = require('../../utils/helpers');
const repo = require('../../db/repo');
const voiceStateEvent = require('../../events/voiceStateUpdate');
const logger = require('../../utils/logger');

const data = new ContextMenuCommandBuilder()
  .setName('vban')
  .setType(ApplicationCommandType.User);

// Risoluzione ownership duplicata (piccola, evita import circolari con
// tempchannel.js che è il command "voice"). L'utente può agire se è owner del
// temp voice OPPURE se ha il flag Administrator (può fare tutto quello che
// farebbe l'owner su QUALSIASI vocale temporanea del guild).
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
    logger.warn({ err: err.message, channel: channel.id }, 'syncSnapshot fallito (vban)');
  }
}

async function execute(interaction) {
  if (!interaction.guildId) return;

  const target = await interaction.guild.members.fetch(interaction.targetId).catch(() => null);
  if (!target) {
    return interaction.reply({ embeds: [errorEmbed('Utente non trovato', 'Impossibile trovare il membro selezionato.')], flags: MessageFlags.Ephemeral });
  }

  const ownerResult = await resolveOwnedVoiceChannel(interaction);
  if (!ownerResult.ok) return ownerResult.reply;

  if (!target.voice?.channel || target.voice.channel.id !== ownerResult.channel.id) {
    return interaction.reply({ embeds: [errorEmbed('Non in canale', 'Questo utente non è nel tuo canale vocale.')], flags: MessageFlags.Ephemeral });
  }
  if (target.id === ownerResult.temp.owner_id) {
    return interaction.reply({ embeds: [errorEmbed('Non valido', 'Non puoi bandire te stesso.')], flags: MessageFlags.Ephemeral });
  }

  await repo.banVoiceUser(ownerResult.channel.id, target.id);
  try {
    await ownerResult.channel.permissionOverwrites.edit(target.id, { Connect: false }, { reason: 'voice ban' });
  } catch (err) {
    logger.warn({ err: err.message, channel: ownerResult.channel.id, user: target.id }, 'vban: permissionOverwrites fallito');
  }
  try {
    await target.voice.setChannel(null, 'voice vban');
  } catch (err) {
    return interaction.reply({ embeds: [errorEmbed('Errore', err.message)], flags: MessageFlags.Ephemeral });
  }
  await syncSnapshot(interaction, ownerResult.channel);
  return interaction.reply({ embeds: [successEmbed('Bannato', `<@${target.id}> è stato bandito dal tuo canale. Usa \`/voice unban\` per riammetterlo.`)], flags: MessageFlags.Ephemeral });
}

module.exports = { data, execute };
