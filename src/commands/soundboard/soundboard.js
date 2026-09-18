'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const repo = require('../../db/repo');
const { errorEmbed, successEmbed } = require('../../utils/helpers');
const logger = require('../../utils/logger');
const player = require('../../services/soundboard-player');

const ALLOWED_EXTS = ['.mp3', '.ogg', '.wav', '.opus', '.m4a'];
const AUDIO_MIME = /^audio\//;
const PLAY_COOLDOWN_MS = 60_000;
const playCooldowns = new Map();

ensureStorageDir();

function ensureStorageDir() {
  if (!fs.existsSync(config.features.soundboards.storageDir)) {
    fs.mkdirSync(config.features.soundboards.storageDir, { recursive: true });
  }
}

// --- Definizione comando ---------------------------------------------------

const data = new SlashCommandBuilder()
  .setName('soundboard')
  .setDescription('Comandi soundboard')
  .addSubcommand((sc) => sc.setName('add').setDescription('Aggiungi un suono (allega un file audio)').addStringOption((o) => o.setName('nome').setDescription('Nome del suono').setRequired(true).setAutocomplete(true)).addAttachmentOption((o) => o.setName('file').setDescription('File audio').setRequired(true)))
  .addSubcommand((sc) => sc.setName('play').setDescription('Riproduci un suono nel tuo canale vocale').addStringOption((o) => o.setName('nome').setDescription('Nome del suono').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sc) => sc.setName('list').setDescription('Elenco suoni'))
  .addSubcommand((sc) => sc.setName('delete').setDescription('Elimina un suono').addStringOption((o) => o.setName('nome').setDescription('Nome del suono').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sc) => sc.setName('rename').setDescription('Rinomina un suono').addStringOption((o) => o.setName('vecchio_nome').setDescription('Nome attuale').setRequired(true).setAutocomplete(true)).addStringOption((o) => o.setName('nuovo_nome').setDescription('Nuovo nome').setRequired(true)))
  .addSubcommand((sc) => sc.setName('stop').setDescription('Ferma la riproduzione ed esci dal canale vocale'));

// --- Dispatcher -----------------------------------------------------------

async function execute(interaction) {
  if (!config.features.soundboards.enabled) return disabled(interaction);
  const handler = SUBCOMMAND_HANDLERS[interaction.options.getSubcommand()];
  if (!handler) return error(interaction, 'Sottocomando sconosciuto.');
  return handler(interaction);
}

async function autocomplete(interaction) {
  if (!config.features.soundboards.enabled) return interaction.respond([]);
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'nome' && focused.name !== 'vecchio_nome') {
    return interaction.respond([]);
  }
  const matches = await repo.searchSoundboards(interaction.guildId, focused.value, 25);
  return interaction.respond(
    matches.map((s) => ({ name: s.name, value: s.name }))
  );
}

const SUBCOMMAND_HANDLERS = {
  add: cmdAdd,
  play: cmdPlay,
  list: cmdList,
  delete: cmdDelete,
  rename: cmdRename,
  stop: cmdStop,
};

// --- Sottocomandi ---------------------------------------------------------

async function cmdAdd(interaction) {
  const name = safeName(interaction.options.getString('nome'));
  if (!name) return error(interaction, 'Usa lettere, numeri, _, -.');

  if (await repo.getSoundboard(interaction.guildId, name)) {
    return error(interaction, `Il suono "${name}" esiste già.`);
  }

  const file = interaction.options.getAttachment('file');
  const maxBytes = config.features.soundboards.maxFileSizeMb * 1024 * 1024;
  if (file.size > maxBytes) return error(interaction, `Massimo ${config.features.soundboards.maxFileSizeMb}MB.`);

  if (!AUDIO_MIME.test(file.contentType || '') && !hasAllowedExt(file.name)) {
    return error(interaction, 'Usa mp3, ogg, wav, opus, m4a.');
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const buf = await downloadBuffer(file.url);
  const ext = path.extname(file.name) || '.mp3';
  const filePath = path.join(guildDir(interaction.guildId), `${name}${ext}`);
  fs.writeFileSync(filePath, buf);

  await repo.createSoundboard(interaction.guildId, interaction.user.id, name, filePath, buf.length);
  await interaction.editReply({ embeds: [successEmbed('Aggiunto', `Suono **${name}** salvato (${(buf.length / 1024).toFixed(1)}KB).`)] });
}

async function cmdPlay(interaction) {
  const voice = interaction.member?.voice;
  if (!voice?.channel) return error(interaction, 'Entra in un canale vocale.');

  const name = safeName(interaction.options.getString('nome'));
  const sb = await repo.getSoundboard(interaction.guildId, name);
  if (!sb) return error(interaction, `Nessun suono "${name}".`);
  if (!fs.existsSync(sb.file_path)) return error(interaction, 'File audio mancante su disco.');

  const key = `${interaction.guildId}:${interaction.user.id}`;
  const last = playCooldowns.get(key) || 0;
  const remaining = PLAY_COOLDOWN_MS - (Date.now() - last);
  if (remaining > 0) {
    const secondsLeft = Math.ceil(remaining / 1000);
    return error(interaction, `Aspetta **${secondsLeft}s** prima di lanciare un altro suono.`);
  }
  playCooldowns.set(key, Date.now());

  try {
    await player.play(interaction.guild, voice.channel, sb.file_path, config.features.soundboards.volume);
  } catch (err) {
    playCooldowns.delete(key);
    return error(interaction, err.message);
  }

  await repo.incrementSoundboardPlays(interaction.guildId, name);
  await interaction.reply({ embeds: [successEmbed('In riproduzione', `▶️ **${name}**`)], flags: MessageFlags.Ephemeral });
}

async function cmdList(interaction) {
  const sounds = await repo.listSoundboards(interaction.guildId, 25);
  if (sounds.length === 0) return error(interaction, 'Nessun suono ancora.');

  const lines = sounds.map((s, i) => `**${i + 1}.** ${s.name} — ${s.plays} riproduzioni`);
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🔊 Soundboard').setDescription(lines.join('\n'))] });
}

async function cmdDelete(interaction) {
  const name = safeName(interaction.options.getString('nome'));
  const sb = await repo.getSoundboard(interaction.guildId, name);
  if (!sb) return error(interaction, `Nessun suono "${name}".`);
  if (sb.user_id !== interaction.user.id) return error(interaction, 'Puoi eliminare solo i tuoi suoni.');

  await repo.deleteSoundboard(interaction.guildId, name);
  safeUnlink(sb.file_path);
  await interaction.reply({ embeds: [successEmbed('Eliminato', `Suono **${name}** rimosso.`)] });
}

async function cmdRename(interaction) {
  const oldName = safeName(interaction.options.getString('vecchio_nome'));
  const newName = safeName(interaction.options.getString('nuovo_nome'));

  const sb = await repo.getSoundboard(interaction.guildId, oldName);
  if (!sb) return error(interaction, `Nessun suono "${oldName}".`);
  if (sb.user_id !== interaction.user.id) return error(interaction, 'Puoi rinominare solo i tuoi suoni.');
  if (await repo.getSoundboard(interaction.guildId, newName)) return error(interaction, `Il suono "${newName}" esiste già.`);

  await repo.renameSoundboard(interaction.guildId, oldName, newName);

  const ext = path.extname(sb.file_path);
  const dir = path.dirname(sb.file_path);
  try { fs.renameSync(sb.file_path, path.join(dir, `${newName}${ext}`)); } catch (err) {
    logger.warn({ err }, 'rinomina file soundboard fallita');
  }

  await interaction.reply({ embeds: [successEmbed('Rinominato', `**${oldName}** → **${newName}**`)] });
}

async function cmdStop(interaction) {
  player.stop(interaction.guildId);
  await interaction.reply({ embeds: [successEmbed('Fermato', 'Sono uscito dal canale vocale.')], flags: MessageFlags.Ephemeral });
}

// --- Helper ---------------------------------------------------------------

function safeName(raw) {
  return raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 50);
}

function hasAllowedExt(filename) {
  return ALLOWED_EXTS.some((ext) => filename.toLowerCase().endsWith(ext));
}

function guildDir(guildId) {
  const dir = path.join(config.features.soundboards.storageDir, guildId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function downloadBuffer(url) {
  const res = await fetch(url);
  return Buffer.from(await res.arrayBuffer());
}

function safeUnlink(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) {}
}

function disabled(interaction) {
  return interaction.reply({ embeds: [errorEmbed('Disabilitato', 'Le soundboard sono spente.')], flags: MessageFlags.Ephemeral });
}

function error(interaction, msg) {
  return interaction.reply({ embeds: [errorEmbed('Errore', msg)], flags: MessageFlags.Ephemeral });
}

module.exports = { data, execute, autocomplete };
