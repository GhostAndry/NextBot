'use strict';

// Generatore di trascrizioni HTML per i ticket.
// Sostituisce `discord-html-transcripts` (che richiedeva React + ReactDOM)
// con un renderer HTML statico, scritto a mano.
//
// API:
//   build(channel)            -> Buffer HTML di tutti i messaggi del canale
//   filename(channelId)       -> nome del file allegato

const { ChannelType, escapeMarkdown } = require('discord.js');

const MESSAGE_FETCH_LIMIT = 1000;

async function build(channel) {
  const messages = await fetchAllMessages(channel);
  const html = renderHtml(channel, messages);
  return Buffer.from(html, 'utf8');
}

function filename(channelId) {
  return `trascrizione-${channelId}.html`;
}

async function fetchAllMessages(channel) {
  const all = [];
  let before;
  while (all.length < MESSAGE_FETCH_LIMIT) {
    const options = { limit: 100 };
    if (before) options.before = before;
    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return all.reverse();
}

function renderHtml(channel, messages) {
  const channelName = escapeText(channel.name || 'canale');
  const guildName = channel.guild ? escapeText(channel.guild.name) : 'DM';
  const rows = messages.map(renderMessage).join('\n');
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<title>Trascrizione #${channelName}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #2b2d31; color: #dcddde; margin: 0; padding: 24px; }
  h1 { font-size: 18px; color: #f2f3f5; border-bottom: 1px solid #3f4147; padding-bottom: 12px; }
  .meta { color: #949ba4; font-size: 13px; margin-bottom: 24px; }
  .msg { display: flex; padding: 6px 8px; border-radius: 4px; margin-bottom: 2px; }
  .msg:hover { background: #32353b; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; background: #5865f2; flex-shrink: 0; margin-right: 12px; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 16px; }
  .body { flex: 1; min-width: 0; }
  .header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
  .author { font-weight: 600; color: #f2f3f5; }
  .bot { background: #5865f2; color: #fff; font-size: 10px; padding: 1px 4px; border-radius: 3px; }
  .ts { color: #949ba4; font-size: 12px; }
  .content { white-space: pre-wrap; word-wrap: break-word; line-height: 1.4; }
  .embed { border-left: 4px solid #5865f2; background: #2f3136; padding: 8px 12px; margin-top: 6px; border-radius: 0 4px 4px 0; max-width: 520px; }
  .embed-title { font-weight: 600; color: #f2f3f5; margin-bottom: 4px; }
  .embed-desc { color: #dcddde; font-size: 14px; }
  .embed-field { margin-top: 4px; font-size: 14px; }
  .embed-field-name { font-weight: 600; color: #f2f3f5; display: inline; margin-right: 4px; }
  .att { margin-top: 4px; font-size: 13px; color: #00a8fc; }
  .sys { color: #949ba4; font-style: italic; font-size: 13px; padding: 4px 0; }
</style>
</head>
<body>
<h1>#${channelName}</h1>
<div class="meta">Server: ${guildName} · Messaggi: ${messages.length} · Esportato: ${escapeText(new Date().toLocaleString('it-IT'))}</div>
${rows}
</body>
</html>`;
}

function renderMessage(msg) {
  if (msg.system) {
    return `<div class="sys">${escapeText(getSystemText(msg))}</div>`;
  }
  const author = msg.author || { username: 'sconosciuto', discriminator: '0000', bot: false };
  const initials = (author.username || '?').slice(0, 2).toUpperCase();
  const ts = formatTimestamp(msg.createdAt);
  const body = renderContent(msg);
  const embeds = (msg.embeds || []).map(renderEmbed).join('');
  const attachments = renderAttachments(msg);
  return `<div class="msg">
  <div class="avatar">${escapeText(initials)}</div>
  <div class="body">
    <div class="header">
      <span class="author">${escapeText(author.username || 'sconosciuto')}</span>
      ${author.bot ? '<span class="bot">BOT</span>' : ''}
      <span class="ts">${escapeText(ts)}</span>
    </div>
    ${body}
    ${embeds}
    ${attachments}
  </div>
</div>`;
}

function renderContent(msg) {
  if (!msg.content) return '';
  return `<div class="content">${formatInline(escapeText(msg.content))}</div>`;
}

function formatInline(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<u>$1</u>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderEmbed(embed) {
  let html = '<div class="embed" style="border-left-color: ' + embedColor(embed.color) + '">';
  if (embed.author?.name) html += `<div class="embed-title">${escapeText(embed.author.name)}</div>`;
  if (embed.title) html += `<div class="embed-title">${escapeText(embed.title)}</div>`;
  if (embed.description) html += `<div class="embed-desc">${escapeText(embed.description)}</div>`;
  if (Array.isArray(embed.fields)) {
    for (const f of embed.fields) {
      html += `<div class="embed-field"><span class="embed-field-name">${escapeText(f.name)}</span>${escapeText(f.value || '')}</div>`;
    }
  }
  if (embed.footer?.text) html += `<div class="meta">${escapeText(embed.footer.text)}</div>`;
  html += '</div>';
  return html;
}

function renderAttachments(msg) {
  if (!msg.attachments || msg.attachments.size === 0) return '';
  const parts = [];
  for (const att of msg.attachments.values()) {
    parts.push(`<div class="att">📎 ${escapeText(att.name || 'allegato')} — <a href="${escapeAttr(att.url)}">${escapeText(att.url)}</a></div>`);
  }
  return parts.join('');
}

function embedColor(color) {
  if (color == null) return '#5865f2';
  return '#' + color.toString(16).padStart(6, '0');
}

function formatTimestamp(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getSystemText(msg) {
  if (msg.type === 1) return `${escapeText(msg.author?.username || 'qualcuno')} ha aggiunto ${escapeText(msg.mentions?.users?.first()?.username || 'un utente')} al canale.`;
  return msg.type ? `Evento di sistema (tipo ${msg.type})` : 'Evento di sistema';
}

function escapeText(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  if (s == null) return '';
  return String(s).replace(/"/g, '&quot;').replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

module.exports = { build, filename };
