'use strict';

const {
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  PermissionFlagsBits,
  ChannelType,
  PermissionsBitField,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
} = require('discord.js');
const config = require('../../config');
const repo = require('../../db/repo');
const settingsResolver = require('../../services/settings-resolver');
const voiceTracker = require('../../services/voice-state-tracker');
const voiceStateEvent = require('../../events/voiceStateUpdate');
const { successEmbed, errorEmbed, isOwnerOrAdmin } = require('../../utils/helpers');
const logger = require('../../utils/logger');

// Sistema "multi temp voice" stile VoiceMaster/TempVoice: ogni utente che entra
// nell'hub vocale configurato crea il proprio canale privato e ne diventa il
// proprietario. Può rinominare, bloccare, limitare, cacciare, trasferire la
// proprietà o lasciare che altri rivendichino il canale quando esce.
//
// Comandi:
//   /voice create            crea canale testuale temporaneo (legacy, per staff)
//   /voice rename            cambia nome al proprio canale
//   /voice lock / unlock     blocca/riapri join al proprio canale
//   /voice limit             imposta limite utenti (0 = illimitato)
//   /voice kick              caccia un utente dal proprio canale
//   /voice transfer          trasferisce la proprietà a un altro membro
//   /voice claim             prende possesso di un canale orfano
//   /voice permit            riammette un utente precedentemente bloccato
//   /voice info              mostra config del canale attuale
//
// Comportamento runtime:
//   - Quando l'owner lascia, il canale resta aperto finché non si svuota.
//     Se è attivo `autoClaimOnLeave`, il primo utente presente può /voice claim.
//   - Gli utenti in `blocked` vengono kickati automaticamente se provano a entrare.

const DEFAULT_TEXT_MINUTES = 5;
const MIN_TEXT_MINUTES = 1;
const MAX_TEXT_MINUTES = 1440;

const CMD = 'voice';

// CustomId: `<commandName>:<action>` - il dispatcher in interactionCreate usa il
// prefisso `voice:` per instradare i bottoni. Ogni customId è minuscolo.
const BTN = {
  RENAME: `${CMD}:btn:rename`,
  LOCK: `${CMD}:btn:lock`,
  UNLOCK: `${CMD}:btn:unlock`,
  LIMIT: `${CMD}:btn:limit`,
  KICK: `${CMD}:btn:kick`,
  BAN: `${CMD}:btn:ban`,
  UNBAN: `${CMD}:btn:unban`,
  TRANSFER: `${CMD}:btn:transfer`,
  CLAIM: `${CMD}:btn:claim`,
  REFRESH: `${CMD}:btn:refresh`,
};

// Select menus del pannello. Seleziono direttamente il membro del canale
// senza costringere l'utente a scrivere l'ID a mano.
const SEL = {
  KICK: `${CMD}:sel:kick`,
  BAN: `${CMD}:sel:ban`,
  UNBAN: `${CMD}:sel:unban`,
  TRANSFER: `${CMD}:sel:transfer`,
};
const MODAL = {
  RENAME: `${CMD}:modal:rename`,
  LIMIT: `${CMD}:modal:limit`,
};

// --- Definizione comando ---------------------------------------------------

const data = new SlashCommandBuilder()
  .setName(CMD)
  .setDescription('Canali vocali temporanei: ogni membro è proprietario del proprio canale')
  .addSubcommand((sc) => sc.setName('create').setDescription('Crea un canale testuale temporaneo')
    .addStringOption((o) => o.setName('nome').setDescription('Nome del canale').setRequired(true))
    .addIntegerOption((o) => o.setName('minuti').setDescription('Auto-elimina dopo N minuti (default 5)').setMinValue(MIN_TEXT_MINUTES).setMaxValue(MAX_TEXT_MINUTES)))
  .addSubcommand((sc) => sc.setName('rename').setDescription('Rinomina il tuo canale').addStringOption((o) => o.setName('nome').setDescription('Nuovo nome (max 90 caratteri)').setRequired(true).setMaxLength(90)))
  .addSubcommand((sc) => sc.setName('lock').setDescription('Blocca l\'accesso al tuo canale'))
  .addSubcommand((sc) => sc.setName('unlock').setDescription('Sblocca l\'accesso al tuo canale'))
  .addSubcommand((sc) => sc.setName('limit').setDescription('Cambia il limite utenti (0=illimitato)').addIntegerOption((o) => o.setName('numero').setDescription('0-99').setMinValue(0).setMaxValue(99).setRequired(true)))
  .addSubcommand((sc) => sc.setName('kick').setDescription('Espelle un utente dal tuo canale (può rientrare subito)').addStringOption((o) => o.setName('utente').setDescription('Utente da espellere (solo membri del tuo canale)').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sc) => sc.setName('ban').setDescription('Bandisce un utente dal tuo canale (impedisce di rientrare)').addStringOption((o) => o.setName('utente').setDescription('Utente da bandire (solo membri del tuo canale)').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sc) => sc.setName('unban').setDescription('Riammette un utente precedentemente bandito').addStringOption((o) => o.setName('utente').setDescription('Utente da riammettere (deve essere già bandito)').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sc) => sc.setName('transfer').setDescription('Trasferisci la proprietà a un altro membro').addStringOption((o) => o.setName('utente').setDescription('Nuovo proprietario (deve essere nel canale)').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sc) => sc.setName('claim').setDescription('Rivendica un canale temporaneo orfano (owner assente)'))
  .addSubcommand((sc) => sc.setName('info').setDescription('Mostra la configurazione del tuo canale'));

// --- Dispatcher -----------------------------------------------------------

async function execute(interaction) {
  if (!config.features.tempChannels.enabled) return disabled(interaction);

  const sub = interaction.options.getSubcommand();
  const handler = SUBCOMMAND_HANDLERS[sub];
  if (!handler) return error(interaction, 'Sottocomando sconosciuto.');
  return handler(interaction);
}

async function autocomplete(interaction) {
  // autocomplete solo per i subcommand che usano StringOption al posto di
  // UserOption. Filtriamo sui membri attualmente nel canale vocale
  // dell'utente che invoca il comando.
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'utente') return interaction.respond([]);

  const sub = interaction.options.getSubcommand();
  if (!['kick', 'transfer', 'ban', 'unban'].includes(sub)) {
    return interaction.respond([]);
  }

  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) return interaction.respond([]);

  const needle = focused.value.toLowerCase();
  const ownerId = voiceTracker.getOwnerId(interaction.guildId, voiceChannel.id);

  // Per /voice unban la fonte è la lista banned del canale (il membro non è
  // più connesso, è proprio quello il punto), non i membri attuali.
  if (sub === 'unban') {
    const temp = await repo.getTempChannel(voiceChannel.id).catch(() => null);
    const banned = Array.isArray(temp?.banned) ? temp.banned : [];
    if (banned.length === 0) return interaction.respond([]);

    const choices = [];
    for (const userId of banned) {
      let label = userId;
      let detail = '';
      try {
        const m = await interaction.guild.members.fetch(userId);
        label = m.user.globalName || m.user.username;
        detail = m.user.tag;
      } catch (_) {
        // utente non più in guild: mostriamo l'ID come label
        detail = 'non più nel server';
      }
      if (needle && !`${label} ${detail} ${userId}`.toLowerCase().includes(needle)) continue;
      choices.push({ name: label.slice(0, 100), value: userId });
      if (choices.length >= 25) break;
    }
    return interaction.respond(choices);
  }

  const choices = [];
  for (const [, m] of voiceChannel.members) {
    if (m.id === interaction.client.user.id) continue; // escludi il bot
    if (m.id === ownerId) continue; // non puoi kickare/trasferire/bandire te stesso

    const label = m.user.globalName || m.user.username;
    if (needle && !`${label} ${m.user.tag}`.toLowerCase().includes(needle)) continue;

    choices.push({ name: label.slice(0, 100), value: m.id });
    if (choices.length >= 25) break;
  }
  return interaction.respond(choices);
}

async function handleComponent(interaction) {
  // Bottoni del pannello di controllo - agiscono sul canale in cui il messaggio
  // è stato inviato (sono deprecati una volta che l'owner cambia canale, ma
  // vengono invalidati dai check di ownership).
  if (interaction.isStringSelectMenu()) {
    return handleSelectMenu(interaction);
  }

  if (!interaction.isButton()) return false;

  const result = await resolveOwnedVoiceChannel(interaction);
  if (!result.ok) return result.reply;

  const { channel, temp } = result;
  switch (interaction.customId) {
    case BTN.RENAME:
      return showRenameModal(interaction);
    case BTN.LOCK:
      return setLocked(interaction, channel, temp, true);
    case BTN.UNLOCK:
      return setLocked(interaction, channel, temp, false);
    case BTN.LIMIT:
      return showLimitModal(interaction);
    case BTN.KICK:
      return showKickSelect(interaction);
    case BTN.BAN:
      return showBanSelect(interaction);
    case BTN.UNBAN:
      return showUnbanSelect(interaction);
    case BTN.TRANSFER:
      return showTransferSelect(interaction);
    case BTN.CLAIM:
      return claimChannel(interaction, channel, temp);
    case BTN.REFRESH:
      return interaction.update({ embeds: [buildPanel(channel, temp)], components: interaction.message.components });
    default:
      return false;
    }
}

async function handleSelectMenu(interaction) {
  // SELECT.KICK / SELECT.TRANSFER: l'owner ha scelto un membro dal menu e ora
  // eseguiamo l'azione corrispondente sul membro scelto.
  const result = await resolveOwnedVoiceChannel(interaction);
  if (!result.ok) return result.reply;

  const targetId = interaction.values?.[0];
  if (!targetId) return interaction.update({ embeds: [errorEmbed('Selezione vuota', 'Nessun membro selezionato.')], components: [] });

  if (interaction.customId === SEL.KICK) {
    const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!targetMember?.voice?.channel || targetMember.voice.channel.id !== result.channel.id) {
      return interaction.update({ embeds: [errorEmbed('Non in canale', 'Questo utente non è più nel tuo canale.')], components: [] });
    }
    try {
      await targetMember.voice.setChannel(null, 'voice kick');
    } catch (err) {
      return interaction.update({ embeds: [errorEmbed('Errore', err.message)], components: [] });
    }
    await syncSnapshot(interaction, result.channel);
    return interaction.update({ embeds: [successEmbed('Espulso', `<@${targetId}> è stato espulso. Può rientrare liberamente.`)], components: [] });
  }

  if (interaction.customId === SEL.BAN) {
    await interaction.deferUpdate().catch(() => {});
    const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!targetMember?.voice?.channel || targetMember.voice.channel.id !== result.channel.id) {
      return interaction.editReply({ embeds: [errorEmbed('Non in canale', 'Questo utente non è più nel tuo canale.')], components: [] });
    }
    if (targetId === result.temp.owner_id) {
      return interaction.editReply({ embeds: [errorEmbed('Non valido', 'Non puoi bandire te stesso.')], components: [] });
    }
    await repo.banVoiceUser(result.channel.id, targetId);
    // Permission overwrite: Connect:false. Così anche se l'unban dimentica la
    // lista banned, il canale resta precluso a livello Discord.
    try {
      await result.channel.permissionOverwrites.edit(targetId, { Connect: false }, { reason: 'voice ban' });
    } catch (err) {
      logger.warn({ err: err.message, channel: result.channel.id, user: targetId }, 'voice ban: permissionOverwrites fallito');
    }
    try {
      await targetMember.voice.setChannel(null, 'voice ban');
    } catch (err) {
      return interaction.editReply({ embeds: [errorEmbed('Errore', err.message)], components: [] });
    }
    await syncSnapshot(interaction, result.channel);
    return interaction.editReply({ embeds: [successEmbed('Bannato', `<@${targetId}> è stato bandito dal canale. Usa \`/voice unban\` per riammesso.`)], components: [] });
  }

  if (interaction.customId === SEL.UNBAN) {
    await interaction.deferUpdate().catch(() => {});
    const banned = Array.isArray(result.temp.banned) ? result.temp.banned : [];
    if (!banned.includes(targetId)) {
      return interaction.editReply({ embeds: [errorEmbed('Non bandito', 'Questo utente non è nella lista banditi.')], components: [] });
    }
    await repo.unbanVoiceUser(result.channel.id, targetId);
    // Rimuovi l'overwrite se esiste (se l'utente non è in guild, la delete
    // fallisce silente, va bene).
    try {
      await result.channel.permissionOverwrites.delete(targetId, 'voice unban');
    } catch (_) {
      try {
        await result.channel.permissionOverwrites.edit(targetId, { Connect: null }, { reason: 'voice unban' });
      } catch (_) {}
    }
    await syncSnapshot(interaction, result.channel);
    return interaction.editReply({ embeds: [successEmbed('Riamesso', `<@${targetId}> può rientrare nel canale.`)], components: [] });
  }

  if (interaction.customId === SEL.TRANSFER) {
    if (targetId === result.temp.owner_id) {
      return interaction.update({ embeds: [errorEmbed('Sei già proprietario', 'Sei già il proprietario.')], components: [] });
    }
    const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!targetMember?.voice?.channel || targetMember.voice.channel.id !== result.channel.id) {
      return interaction.update({ embeds: [errorEmbed('Non in canale', 'Il nuovo proprietario deve essere nel canale.')], components: [] });
    }
    await repo.transferTempOwnership(result.channel.id, targetId);
    voiceTracker.set(interaction.guildId, result.channel.id, targetId);
    await voiceStateEvent.renameForNewOwner(result.channel, targetMember);
    const fresh = await repo.getTempChannel(result.channel.id);
    if (fresh) await voiceStateEvent.liveSyncVoiceRoom(result.channel, { ...fresh, owner_id: targetId, guild_id: interaction.guildId });
    return interaction.update({ embeds: [successEmbed('Trasferito', `<@${targetId}> è ora il proprietario del canale.`)], components: [] });
  }

  return false;
}

async function handleModal(interaction) {
  const result = await resolveOwnedVoiceChannel(interaction);
  if (!result.ok) return result.reply;
  const { channel: voiceChan, temp } = result;

  if (interaction.customId === MODAL.RENAME) {
    const name = interaction.fields.getTextInputValue('nome')?.trim();
    if (!name || name.length < 1) return interaction.reply({ embeds: [errorEmbed('Nome non valido', 'Inserisci un nome.')], flags: MessageFlags.Ephemeral });
    try {
      await voiceChan.setName(name.slice(0, 90), 'voice rename');
    } catch (err) {
      return interaction.reply({ embeds: [errorEmbed('Errore', err.message)], flags: MessageFlags.Ephemeral });
    }
    await syncSnapshot(interaction, voiceChan);
    return interaction.reply({ embeds: [successEmbed('Rinominato', `Canale rinominato in **${name}**.`)], flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === MODAL.LIMIT) {
    const raw = interaction.fields.getTextInputValue('limite');
    const n = parseInt(raw, 10);
    if (Number.isNaN(n) || n < 0 || n > 99) {
      return interaction.reply({ embeds: [errorEmbed('Valore non valido', 'Inserisci un numero tra 0 e 99.')], flags: MessageFlags.Ephemeral });
    }
    try {
      await voiceChan.setUserLimit(n, 'voice limit');
    } catch (err) {
      return interaction.reply({ embeds: [errorEmbed('Errore', err.message)], flags: MessageFlags.Ephemeral });
    }
    await syncSnapshot(interaction, voiceChan);
return interaction.reply({ embeds: [successEmbed('Limite aggiornato', n === 0 ? 'Illimitato.' : `Massimo **${n}** utenti.`)], flags: MessageFlags.Ephemeral });
}

const SUBCOMMAND_HANDLERS = {
  create: cmdCreateText,
  rename: cmdRename,
  lock: cmdLock,
  unlock: cmdUnlock,
  limit: cmdLimit,
  kick: cmdKick,
  ban: cmdBan,
  unban: cmdUnban,
  permit: cmdPermit,
  transfer: cmdTransfer,
  claim: cmdClaim,
  info: cmdInfo,
};
};

// --- create (canale testuale temporaneo, legacy) --------------------------

async function cmdCreateText(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return error(interaction, 'Solo lo staff può creare canali testuali temporanei.');
  }
  const name = interaction.options.getString('nome');
  const minutes = interaction.options.getInteger('minuti') || DEFAULT_TEXT_MINUTES;

  let channel;
  try {
    channel = await interaction.guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: interaction.channel.parentId,
      permissionOverwrites: buildPermissionOverwrites(interaction),
    });
  } catch (err) {
    return error(interaction, err.message);
  }

  await repo.openTempChannel(channel.id, interaction.guildId, interaction.user.id, 'text');
  await interaction.reply({ embeds: [successEmbed('Creato', `${channel} verrà eliminato automaticamente tra ${minutes} minuti.`)], flags: MessageFlags.Ephemeral });
  scheduleTextDelete(channel, minutes);
}

function scheduleTextDelete(channel, minutes) {
  setTimeout(async () => {
    try {
      const fresh = channel.guild.channels.cache.get(channel.id);
      if (!fresh) return;
      await repo.removeTempChannel(channel.id);
      await fresh.delete('canale temporaneo scaduto');
    } catch (_) {}
  }, minutes * 60 * 1000);
}

// --- rename / limit (via argomenti) ---------------------------------------

// Helper: rilegge il canale temp dal DB + sincronizza lo snapshot VoiceRoom,
// così se il canale viene eliminato all'improvviso le impostazioni sono già
// persistenti. Centralizzato per ridurre boilerplate.
async function syncSnapshot(interaction, channel) {
  try {
    const temp = await repo.getTempChannel(channel.id);
    if (temp) await voiceStateEvent.liveSyncVoiceRoom(channel, temp);
  } catch (err) {
    logger.warn({ err: err.message, channel: channel.id }, 'syncSnapshot fallito');
  }
}

async function cmdRename(interaction) {
  const result = await resolveOwnedVoiceChannel(interaction);
  if (!result.ok) return result.reply;

  const name = interaction.options.getString('nome');
  try {
    await result.channel.setName(name.slice(0, 90), 'voice rename');
  } catch (err) {
    return error(interaction, err.message);
  }
  await syncSnapshot(interaction, result.channel);
  await interaction.reply({ embeds: [successEmbed('Rinominato', `Canale rinominato in **${name}**.`)], flags: MessageFlags.Ephemeral });
}

async function cmdLimit(interaction) {
  const result = await resolveOwnedVoiceChannel(interaction);
  if (!result.ok) return result.reply;

  const n = interaction.options.getInteger('numero');
  try {
    await result.channel.setUserLimit(n, 'voice limit');
  } catch (err) {
    return error(interaction, err.message);
  }
  await syncSnapshot(interaction, result.channel);
  await interaction.reply({ embeds: [successEmbed('Limite aggiornato', n === 0 ? 'Illimitato.' : `Massimo **${n}** utenti.`)], flags: MessageFlags.Ephemeral });
}

// --- lock / unlock --------------------------------------------------------

async function cmdLock(interaction) {
  const result = await resolveOwnedVoiceChannel(interaction);
  if (!result.ok) return result.reply;
  return setLocked(interaction, result.channel, result.temp, true);
}

async function cmdUnlock(interaction) {
  const result = await resolveOwnedVoiceChannel(interaction);
  if (!result.ok) return result.reply;
  return setLocked(interaction, result.channel, result.temp, false);
}

async function setLocked(interaction, channel, temp, locked) {
  await repo.setTempLocked(channel.id, locked);
  if (locked) {
    await channel.permissionOverwrites.edit(interaction.guild.id, { Connect: false }, { reason: 'voice lock' });
  } else {
    await channel.permissionOverwrites.edit(interaction.guild.id, { Connect: null }, { reason: 'voice unlock' });
  }
  if (locked && channel.members.size > 0) {
    // Caccia chi non è autorizzato (owner + bot + admin restano).
    const allow = new Set([temp.owner_id, interaction.client.user.id]);
    for (const [, member] of channel.members) {
      if (allow.has(member.id)) continue;
      // Gli admin del guild restano anche a canale lockato (sono super-owner).
      if (member.permissions?.has?.(PermissionsBitField.Flags.Administrator)) continue;
      try { await member.voice.setChannel(null, 'voice locked'); } catch (_) {}
    }
  }
  // Rileggo temp aggiornato dal DB (locked cambiato) per sincronizzare lo snapshot.
  const fresh = await repo.getTempChannel(channel.id);
  if (fresh) await voiceStateEvent.liveSyncVoiceRoom(channel, fresh);
  return interaction.reply({ embeds: [successEmbed(locked ? 'Bloccato' : 'Sbloccato', `Il canale è ora **${locked ? 'bloccato' : 'aperto'}** ai nuovi ingressi.`)], flags: MessageFlags.Ephemeral });
}

// --- kick / ban / unban / permit -----------------------------------------
//
// Differenze semantiche:
//   - kick: solo `voice.setChannel(null)`. Niente blocked list, niente
//     permission overwrites. L'utente può rientrare immediatamente.
//   - ban:  espelle + `permissionOverwrites.edit(user, { Connect: false })` +
//     aggiunge alla lista banned (persiste nello snapshot VoiceRoom). Anche
//     se l'owner lascia e il canale si ricrea, il ban sopravvive.
//   - unban: rimuove da banned + `permissionOverwrites.delete(user)`.
//   - permit: retrocompat — rimuove da blocked (lista usata dal vecchio kick).

async function cmdKick(interaction) {
  const result = await resolveOwnedVoiceChannel(interaction);
  if (!result.ok) return result.reply;

  const targetId = interaction.options.getString('utente');
  if (!/^\d{17,20}$/.test(targetId)) return error(interaction, 'Utente non valido.');
  const member = await interaction.guild.members.fetch(targetId).catch(() => null);
  if (!member?.voice?.channel || member.voice.channel.id !== result.channel.id) {
    return error(interaction, 'Questo utente non è nel tuo canale.');
  }
  if (targetId === result.temp.owner_id) {
    return error(interaction, 'Non puoi espellere te stesso.');
  }
  try {
    await member.voice.setChannel(null, 'voice kick');
  } catch (err) {
    return error(interaction, err.message);
  }
  await syncSnapshot(interaction, result.channel);
  return interaction.reply({ embeds: [successEmbed('Espulso', `<@${targetId}> è stato espulso. Può rientrare liberamente.`)], flags: MessageFlags.Ephemeral });
}

async function cmdBan(interaction) {
  const result = await resolveOwnedVoiceChannel(interaction);
  if (!result.ok) return result.reply;

  const targetId = interaction.options.getString('utente');
  if (!/^\d{17,20}$/.test(targetId)) return error(interaction, 'Utente non valido.');
  const member = await interaction.guild.members.fetch(targetId).catch(() => null);
  if (!member?.voice?.channel || member.voice.channel.id !== result.channel.id) {
    return error(interaction, 'Questo utente non è nel tuo canale.');
  }
  if (targetId === result.temp.owner_id) {
    return error(interaction, 'Non puoi bandire te stesso.');
  }
  await repo.banVoiceUser(result.channel.id, targetId);
  // Permission overwrite: Connect:false. Difesa in profondità: anche se unban
  // dimentica la lista, Discord blocca l'ingresso.
  try {
    await result.channel.permissionOverwrites.edit(targetId, { Connect: false }, { reason: 'voice ban' });
  } catch (err) {
    logger.warn({ err: err.message, channel: result.channel.id, user: targetId }, 'voice ban: permissionOverwrites fallito');
  }
  try {
    await member.voice.setChannel(null, 'voice ban');
  } catch (err) {
    return error(interaction, err.message);
  }
  await syncSnapshot(interaction, result.channel);
  return interaction.reply({ embeds: [successEmbed('Bannato', `<@${targetId}> è stato bandito dal canale. Usa \`/voice unban\` per riammetterlo.`)], flags: MessageFlags.Ephemeral });
}

async function cmdUnban(interaction) {
  const result = await resolveOwnedVoiceChannel(interaction);
  if (!result.ok) return result.reply;

  const targetId = interaction.options.getString('utente');
  if (!/^\d{17,20}$/.test(targetId)) return error(interaction, 'Utente non valido.');
  const banned = Array.isArray(result.temp.banned) ? result.temp.banned : [];
  if (!banned.includes(targetId)) {
    return error(interaction, 'Questo utente non è bandito dal tuo canale.');
  }
  await repo.unbanVoiceUser(result.channel.id, targetId);
  try {
    await result.channel.permissionOverwrites.delete(targetId, 'voice unban');
  } catch (_) {
    try {
      await result.channel.permissionOverwrites.edit(targetId, { Connect: null }, { reason: 'voice unban' });
    } catch (_) {}
  }
  await syncSnapshot(interaction, result.channel);
  return interaction.reply({ embeds: [successEmbed('Riamesso', `<@${targetId}> può rientrare nel canale.`)], flags: MessageFlags.Ephemeral });
}

async function cmdPermit(interaction) {
  const result = await resolveOwnedVoiceChannel(interaction);
  if (!result.ok) return result.reply;

  const targetId = interaction.options.getString('utente');
  if (!/^\d{17,20}$/.test(targetId)) return error(interaction, 'Utente non valido.');
  await repo.removeBlockedUser(result.channel.id, targetId);
  await syncSnapshot(interaction, result.channel);
  return interaction.reply({ embeds: [successEmbed('Riammesso', `<@${targetId}> può rientrare.`)], flags: MessageFlags.Ephemeral });
}

// --- transfer -------------------------------------------------------------

async function cmdTransfer(interaction) {
  const result = await resolveOwnedVoiceChannel(interaction);
  if (!result.ok) return result.reply;

  const targetId = interaction.options.getString('utente');
  if (!/^\d{17,20}$/.test(targetId)) return error(interaction, 'Utente non valido.');
  if (targetId === result.temp.owner_id) {
    return error(interaction, 'Sei già il proprietario.');
  }
  const member = await interaction.guild.members.fetch(targetId).catch(() => null);
  if (!member?.voice?.channel || member.voice.channel.id !== result.channel.id) {
    return error(interaction, 'Il nuovo proprietario deve essere nel canale.');
  }
  await repo.transferTempOwnership(result.channel.id, targetId);
  voiceTracker.set(interaction.guildId, result.channel.id, targetId);
  await voiceStateEvent.renameForNewOwner(result.channel, member);
  // Lo snapshot passa al nuovo owner.
  const fresh = await repo.getTempChannel(result.channel.id);
  if (fresh) await voiceStateEvent.liveSyncVoiceRoom(result.channel, { ...fresh, owner_id: targetId, guild_id: interaction.guildId });
  return interaction.reply({ embeds: [successEmbed('Trasferito', `<@${targetId}> è ora il proprietario del canale.`)], flags: MessageFlags.Ephemeral });
}

// --- claim ----------------------------------------------------------------

async function cmdClaim(interaction) {
  const channel = interaction.member.voice?.channel;
  if (!channel) return error(interaction, 'Entra prima in un canale vocale.');

  const temp = await repo.getTempChannel(channel.id);
  if (!temp) return error(interaction, 'Questo canale non è temporaneo.');
  if (temp.owner_id === interaction.user.id) {
    return error(interaction, 'Sei già il proprietario.');
  }

  const ownerStillHere = channel.members.has(temp.owner_id);
  if (ownerStillHere) {
    return error(interaction, 'Il proprietario è ancora nel canale.');
  }

  await repo.transferTempOwnership(channel.id, interaction.user.id);
  voiceTracker.set(interaction.guildId, channel.id, interaction.user.id);
  await voiceStateEvent.renameForNewOwner(channel, interaction.member);
  // Lo snapshot passa al nuovo claimer.
  const fresh = await repo.getTempChannel(channel.id);
  if (fresh) await voiceStateEvent.liveSyncVoiceRoom(channel, { ...fresh, owner_id: interaction.user.id, guild_id: interaction.guildId });
  await interaction.reply({ embeds: [successEmbed('Rivendicato', `Ora sei il proprietario di **${channel.name}**.`)], flags: MessageFlags.Ephemeral });
}

async function claimChannel(interaction, channel, temp) {
  // Reclamo da bottone (l'owner ha lasciato o ha abbandonato).
  const ownerStillHere = channel.members.has(temp.owner_id);
  if (ownerStillHere) {
    return interaction.update({ embeds: [interaction.message.embeds[0]], components: interaction.message.components });
  }
  await repo.transferTempOwnership(channel.id, interaction.user.id);
  voiceTracker.set(interaction.guildId, channel.id, interaction.user.id);
  await voiceStateEvent.renameForNewOwner(channel, interaction.member);
  const fresh = await repo.getTempChannel(channel.id);
  if (fresh) await voiceStateEvent.liveSyncVoiceRoom(channel, { ...fresh, owner_id: interaction.user.id, guild_id: interaction.guildId });
  return interaction.reply({ embeds: [successEmbed('Rivendicato', `Ora sei il proprietario di **${channel.name}**.`)], flags: MessageFlags.Ephemeral });
}

// --- info -----------------------------------------------------------------

async function cmdInfo(interaction) {
  const result = await resolveOwnedVoiceChannel(interaction);
  if (!result.ok) return result.reply;
  return interaction.reply({ embeds: [buildPanel(result.channel, result.temp)], flags: MessageFlags.Ephemeral });
}

// --- Pannello di controllo (bottoni) -------------------------------------

function buildPanel(channel, temp) {
  const ownerMention = `<@${temp.owner_id}>`;
  const limit = channel.userLimit === 0 ? '∞' : String(channel.userLimit);
  const blocked = Array.isArray(temp.blocked) ? temp.blocked.length : 0;
  const banned = Array.isArray(temp.banned) ? temp.banned.length : 0;
  const desc = [
    `**Canale:** ${channel}`,
    `**Proprietario:** ${ownerMention}`,
    `**Stato:** ${temp.locked ? '🔒 bloccato' : '🔓 aperto'}`,
    `**Limite utenti:** ${limit}`,
    `**Membri attuali:** ${channel.members.size}`,
    `**Bloccati (kick legacy):** ${blocked}`,
    `**Banditi:** ${banned}`,
  ].join('\n');
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎛️ Pannello controllo canale')
    .setDescription(desc)
    .setFooter({ text: 'I bottoni qui sotto agiscono sul canale in cui ti trovi.' })
    .setTimestamp();
}

function buildControlRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BTN.RENAME).setLabel('Rinomina').setStyle(ButtonStyle.Secondary).setEmoji('✏️'),
    new ButtonBuilder().setCustomId(BTN.LIMIT).setLabel('Limite').setStyle(ButtonStyle.Secondary).setEmoji('👥'),
    new ButtonBuilder().setCustomId(BTN.LOCK).setLabel('Lock').setStyle(ButtonStyle.Primary).setEmoji('🔒'),
    new ButtonBuilder().setCustomId(BTN.UNLOCK).setLabel('Unlock').setStyle(ButtonStyle.Primary).setEmoji('🔓'),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BTN.KICK).setLabel('Kick').setStyle(ButtonStyle.Danger).setEmoji('👢'),
    new ButtonBuilder().setCustomId(BTN.BAN).setLabel('Ban').setStyle(ButtonStyle.Danger).setEmoji('🔨'),
    new ButtonBuilder().setCustomId(BTN.UNBAN).setLabel('Unban').setStyle(ButtonStyle.Success).setEmoji('🔓'),
    new ButtonBuilder().setCustomId(BTN.TRANSFER).setLabel('Proprietario').setStyle(ButtonStyle.Success).setEmoji('👑'),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BTN.CLAIM).setLabel('Claim').setStyle(ButtonStyle.Success).setEmoji('🙋'),
    new ButtonBuilder().setCustomId(BTN.REFRESH).setLabel('Aggiorna').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
  );
  return [row1, row2, row3];
}

function buildRenameModal() {
  return {
    title: 'Rinomina canale',
    customId: MODAL.RENAME,
    components: [[
      { customId: 'nome', label: 'Nuovo nome (max 90)', style: 1, minLength: 1, maxLength: 90, required: true },
    ]],
  };
}

function buildLimitModal() {
  return {
    title: 'Limite utenti (0 = illimitato)',
    customId: MODAL.LIMIT,
    components: [[
      { customId: 'limite', label: 'Numero tra 0 e 99', style: 1, minLength: 1, maxLength: 2, required: true },
    ]],
  };
}


function showRenameModal(interaction) {
  return interaction.showModal(buildModalFromSpec(buildRenameModal()));
}
function showLimitModal(interaction) {
  return interaction.showModal(buildModalFromSpec(buildLimitModal()));
}

// Bottoni KICK / TRANSFER: invece di un modal che chiede un ID (scomodo),
// apriamo un select menu con i membri attuali del canale. Discord permette
// fino a 25 option in un select, ma in un voice channel il limite è quasi
// mai un problema.
function buildMemberSelectRow(interaction, customId, placeholder, exclude) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1);
  let count = 0;
  for (const [, m] of voiceChannel.members) {
    if (m.id === interaction.client.user.id) continue;
    if (exclude && m.id === exclude) continue;
    if (count >= 25) break;
    menu.addOptions({
      label: (m.user.globalName || m.user.username).slice(0, 100),
      description: (m.user.tag || '').slice(0, 100) || undefined,
      value: m.id,
    });
    count += 1;
  }
  if (count === 0) return null;
  return new ActionRowBuilder().addComponents(menu);
}

function showKickSelect(interaction) {
  const row = buildMemberSelectRow(
    interaction,
    SEL.KICK,
    'Scegli chi espellere',
    interaction.user.id,
  );
  if (!row) return interaction.reply({ embeds: [errorEmbed('Nessun membro', 'Non c\'è nessuno da espellere nel tuo canale.')], flags: MessageFlags.Ephemeral });
  return interaction.reply({ components: [row], flags: MessageFlags.Ephemeral });
}

async function showBanSelect(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) return interaction.reply({ embeds: [errorEmbed('Nessun canale', 'Entra prima in un canale vocale.')], flags: MessageFlags.Ephemeral });
  const row = buildMemberSelectRow(
    interaction,
    SEL.BAN,
    'Scegli chi bandire',
    interaction.user.id,
  );
  if (!row) return interaction.reply({ embeds: [errorEmbed('Nessun membro', 'Non c\'è nessuno da bandire nel tuo canale.')], flags: MessageFlags.Ephemeral });
  return interaction.reply({ components: [row], flags: MessageFlags.Ephemeral });
}

async function showUnbanSelect(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) return interaction.reply({ embeds: [errorEmbed('Nessun canale', 'Entra prima in un canale vocale.')], flags: MessageFlags.Ephemeral });
  const temp = await repo.getTempChannel(voiceChannel.id).catch(() => null);
  const banned = Array.isArray(temp?.banned) ? temp.banned : [];
  if (banned.length === 0) {
    return interaction.reply({ embeds: [errorEmbed('Nessun bandito', 'Non c\'è nessun utente bandito nel tuo canale.')], flags: MessageFlags.Ephemeral });
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(SEL.UNBAN)
    .setPlaceholder('Scegli chi riammettere')
    .setMinValues(1)
    .setMaxValues(1);
  let count = 0;
  for (const userId of banned) {
    let label = userId;
    let description;
    try {
      const m = await interaction.guild.members.fetch(userId);
      label = m.user.globalName || m.user.username;
      description = m.user.tag;
    } catch (_) {
      description = 'non più nel server';
    }
    menu.addOptions({
      label: label.slice(0, 100),
      description: (description || '').slice(0, 100) || undefined,
      value: userId,
    });
    count += 1;
    if (count >= 25) break;
  }
  return interaction.reply({ components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
}

function showTransferSelect(interaction) {
  const row = buildMemberSelectRow(
    interaction,
    SEL.TRANSFER,
    'Scegli il nuovo proprietario',
    interaction.user.id,
  );
  if (!row) return interaction.reply({ embeds: [errorEmbed('Nessun candidato', 'Non c\'è nessun membro a cui trasferire il canale.')], flags: MessageFlags.Ephemeral });
  return interaction.reply({ components: [row], flags: MessageFlags.Ephemeral });
}

function buildModalFromSpec(spec) {
  const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
  const modal = new ModalBuilder().setCustomId(spec.customId).setTitle(spec.title);
  const rows = spec.components.map((inputs) => {
    const row = new ActionRowBuilder();
    for (const i of inputs) {
      const input = new TextInputBuilder()
        .setCustomId(i.customId)
        .setLabel(i.label)
        .setStyle(i.style === 1 ? TextInputStyle.Short : TextInputStyle.Paragraph)
        .setRequired(Boolean(i.required))
        .setMinLength(i.minLength || 0)
        .setMaxLength(i.maxLength || 4000);
      row.addComponents(input);
    }
    return row;
  });
  modal.addComponents(...rows);
  return modal;
}

// --- Risoluzione ownership ------------------------------------------------

// Risolve il canale vocale temporaneo su cui l'utente può agire. Usato sia da
// /voice <sub> che dai bottoni. L'utente può agire se è owner del temp voice,
// oppure se ha il flag `Administrator` nel guild (può fare tutto quello che
// farebbe l'owner su QUALSIASI vocale temporanea della guild).
//
// Risposta uniforme:
//   { ok: true, channel, temp }
//   { ok: false, reply: Promise<void> } -- il caller esegue `return result.reply`
async function resolveOwnedVoiceChannel(interaction) {
  const voiceChannel = interaction.member.voice?.channel;
  if (!voiceChannel) return { ok: false, reply: error(interaction, 'Entra prima in un canale vocale.') };

  const temp = await repo.getTempChannel(voiceChannel.id);
  if (!temp || temp.kind !== 'voice') {
    return { ok: false, reply: error(interaction, 'Questo canale non è un temp voice.') };
  }
  if (!isOwnerOrAdmin(interaction.member, temp)) {
    return { ok: false, reply: error(interaction, 'Solo il proprietario o un amministratore può usare questo comando.') };
  }
  return { ok: true, channel: voiceChannel, temp };
}

// --- Invio pannello di benvenuto nel canale --------------------------------

async function sendControlPanel(channel) {
  try {
    const rows = buildControlRows();
    const temp = await repo.getTempChannel(channel.id);
    if (!temp) {
      // Canale non più registrato come temp (es. appena cancellato): niente pannello.
      return;
    }

    // Se esiste già un pannello precedente registrato, cancellalo per evitare
    // duplicati nel canale. Se il messaggio non esiste più (cancellato a mano,
    // scaduto, ecc.) ignora l'errore.
    if (temp.panel_message_id) {
      try {
        const old = await channel.messages.fetch(temp.panel_message_id).catch(() => null);
        if (old) await old.delete('aggiornamento pannello');
      } catch (err) {
        logger.warn({ err: err.message, channel: channel.id, message: temp.panel_message_id }, 'cancellazione pannello precedente fallita');
      }
    }

    const sent = await channel.send({ embeds: [buildPanel(channel, temp)], components: rows });
    await repo.setTempPanelMessageId(channel.id, sent.id).catch((err) =>
      logger.warn({ err: err.message, channel: channel.id }, 'salvataggio panelMessageId fallito'));
  } catch (err) {
    logger.warn({ err: err.message, channel: channel.id }, 'invio pannello controllo fallito');
  }
}

// Esportato perché lo usa l'evento voiceStateUpdate per inviare il pannello
// appena viene creato il canale.

// --- Helper ---------------------------------------------------------------

function buildPermissionOverwrites(interaction) {
  return [
    { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
    { id: interaction.client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels] },
  ];
}

function disabled(interaction) {
  return interaction.reply({ embeds: [errorEmbed('Disabilitato', 'I canali temporanei sono disabilitati.')], flags: MessageFlags.Ephemeral });
}

function error(interaction, msg) {
  return interaction.reply({ embeds: [errorEmbed('Errore', msg)], flags: MessageFlags.Ephemeral });
}

module.exports = { data, execute, autocomplete, handleComponent, handleModal, BTN, MODAL, SEL, sendControlPanel };
