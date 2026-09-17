'use strict';

const { PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');

function hasPermission(member, perm) {
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  return member.permissions?.has?.(perm);
}

function modEmbed(action, target, mod, reason, extra = {}) {
  const e = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`Moderazione: ${action}`)
    .addFields(
      { name: 'Utente', value: `<@${target.id}> (${target.id})`, inline: true },
      { name: 'Moderatore', value: `<@${mod.id}>`, inline: true },
    )
    .setTimestamp();
  if (reason) e.addFields({ name: 'Motivo', value: reason });
  for (const [k, v] of Object.entries(extra)) {
    e.addFields({ name: k, value: String(v), inline: true });
  }
  return e;
}

function infoEmbed(title, description) {
  return new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(description).setTimestamp();
}

function successEmbed(title, description) {
  return new EmbedBuilder().setColor(0x57f287).setTitle(title).setDescription(description).setTimestamp();
}

function errorEmbed(title, description) {
  return new EmbedBuilder().setColor(0xed4245).setTitle(title).setDescription(description).setTimestamp();
}

function parseDuration(str) {
  if (!str) return null;
  const match = /^(\d+)(s|m|h|d)$/i.exec(str.trim());
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const ms = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return n * ms;
}

function formatDuration(ms) {
  if (!ms) return 'permanente';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec && !d) parts.push(`${sec}s`);
  return parts.join(' ') || '0s';
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function safeReply(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.followUp(payload);
    }
    return await interaction.reply(payload);
  } catch (_) {
    return null;
  }
}

// Build reply options with ephemeral flag expressed as MessageFlags bit.
// discord.js v14.x deprecated `flags: MessageFlags.Ephemeral`; this helper centralizes the
// conversion so commands don't sprinkle MessageFlags around.
function ephemeralOpts(payload = {}) {
  const { ephemeral, ...rest } = payload;
  if (!ephemeral) return rest;
  return { ...rest, flags: MessageFlags.Ephemeral };
}

async function replyEphemeral(interaction, payload) {
  return safeReply(interaction, { ...payload, flags: MessageFlags.Ephemeral });
}

async function deferEphemeral(interaction) {
  if (interaction.deferred || interaction.replied) return;
  return interaction.deferReply({ flags: MessageFlags.Ephemeral });
}

module.exports = {
  hasPermission,
  modEmbed,
  infoEmbed,
  successEmbed,
  errorEmbed,
  parseDuration,
  formatDuration,
  chunk,
  safeReply,
  ephemeralOpts,
  replyEphemeral,
  deferEphemeral,
  MessageFlags,
};
