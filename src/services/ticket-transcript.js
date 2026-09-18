'use strict';

// Generatore di trascrizioni HTML per i ticket.
// Renderer HTML statico, scritto a mano, ispirato allo stile di Discord.
// Niente dipendenze esterne: usiamo solo le API discord.js per leggere i dati.
//
// API:
//   build(channel)                  -> Buffer HTML di tutti i messaggi del canale
//   filename(channelId, ticket)     -> nome del file allegato (incluso id ticket)
//   renderHeaderHtml(channel, ticket) -> blocco header da includere prima dei messaggi

const { ChannelType } = require('discord.js');

const MESSAGE_FETCH_LIMIT = 1000;
const AVATAR_SIZE = 40;

// Discord CDN: i link non scadono ma passano per `cdn.discordapp.com`.
function avatarUrl(author) {
  if (!author) return null;
  if (author.avatar) {
    const ext = author.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.${ext}?size=${AVATAR_SIZE * 2}`;
  }
  // Avatar default Discord: identicon basato sull'username.
  const idx = author.discriminator && author.discriminator !== '0'
    ? Number(author.discriminator) % 5
    : Number(BigInt(author.id || '0') % 5n);
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

function displayTag(author) {
  if (!author) return 'sconosciuto';
  // Nuovo username Discord (senza discriminatore) + tag legacy se presente.
  if (!author.discriminator || author.discriminator === '0') {
    return author.globalName || author.username || 'sconosciuto';
  }
  return `${author.username || 'sconosciuto'}#${author.discriminator}`;
}

async function build(channel, ticket = null) {
  const messages = await fetchAllMessages(channel);
  const html = renderHtml(channel, messages, ticket);
  return Buffer.from(html, 'utf8');
}

function filename(channelId, ticket = null) {
  const id = ticket?.id || channelId;
  return `trascrizione-${id}.html`;
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

function renderHtml(channel, messages, ticket) {
  const channelName = escapeText(channel.name || 'canale');
  const guildName = channel.guild ? escapeText(channel.guild.name) : 'DM';
  const header = renderHeader(channel, messages, ticket);
  // Passa `prev` a renderMessage per rilevare messaggi consecutivi dello stesso
  // autore (li mostriamo compatti come fa Discord).
  const rows = messages.map((m, i) => renderMessage(m, messages[i - 1])).join('\n');
  const exportedAt = escapeText(new Date().toLocaleString('it-IT'));
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<title>Trascrizione #${channelName}</title>
<style>
  :root {
    --bg: #313338; --bg-elev: #2b2d31; --bg-hover: #32353b;
    --fg: #f2f3f5; --fg-muted: #949ba4; --fg-dim: #6d6f78;
    --accent: #5865f2; --link: #00a8fc; --ok: #57f287; --warn: #fee75c; --err: #ed4245;
  }
  * { box-sizing: border-box; }
  body { font-family: "gg sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: #dcddde; margin: 0; padding: 0; }
  header.ticket {
    background: var(--bg-elev); padding: 20px 24px; border-bottom: 1px solid #1e1f22;
    position: sticky; top: 0; z-index: 10;
  }
  header.ticket h1 { margin: 0 0 4px; font-size: 18px; color: var(--fg); }
  header.ticket .meta { color: var(--fg-muted); font-size: 13px; }
  header.ticket .pill { display: inline-block; padding: 2px 8px; border-radius: 10px; background: var(--accent); color: #fff; font-size: 11px; font-weight: 700; margin-right: 6px; text-transform: uppercase; }
  main { padding: 16px 0 64px; max-width: 920px; margin: 0 auto; }
  .divider { height: 1px; background: #3f4147; margin: 16px 24px; }
  .msg { display: flex; padding: 4px 20px; margin: 2px 0; }
  .msg:hover { background: var(--bg-hover); }
  .msg.mentioned { background: rgba(88, 101, 242, 0.08); border-left: 2px solid var(--accent); padding-left: 18px; }
  .msg.continued { padding-top: 0; }
  .msg.continued .header { display: none; }
  .msg.continued .avatar { visibility: hidden; height: 0; }
  .avatar { width: ${AVATAR_SIZE}px; height: ${AVATAR_SIZE}px; border-radius: 50%; flex-shrink: 0; margin-right: 16px; margin-top: 2px; overflow: hidden; background: var(--accent); }
  .avatar img { width: 100%; height: 100%; display: block; }
  .body { flex: 1; min-width: 0; }
  .header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 2px; }
  .author { font-weight: 600; color: var(--fg); font-size: 15px; }
  .bot-tag { background: var(--accent); color: #fff; font-size: 10px; padding: 1px 5px; border-radius: 3px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; }
  .ts { color: var(--fg-muted); font-size: 12px; }
  .edited { color: var(--fg-dim); font-size: 11px; margin-left: 4px; }
  .content { white-space: pre-wrap; word-wrap: break-word; line-height: 1.45; font-size: 15px; }
  .content code { background: #2b2d31; padding: 1px 4px; border-radius: 3px; font-family: "JetBrains Mono", Consolas, monospace; font-size: 13px; }
  .content pre { background: #2b2d31; padding: 8px 10px; border-radius: 4px; font-size: 13px; overflow-x: auto; }
  .content blockquote { border-left: 4px solid #4f545c; padding-left: 8px; margin: 4px 0; color: var(--fg-muted); }
  .mention { background: rgba(88, 101, 242, 0.15); color: #c4c9ff; padding: 0 2px; border-radius: 2px; }
  .spoiler { background: var(--fg); color: var(--fg); padding: 0 4px; border-radius: 3px; cursor: pointer; }
  .spoiler.revealed { background: #4f545c; color: var(--fg); }
  .embed { border-left: 4px solid var(--accent); background: #2f3136; padding: 10px 12px; margin-top: 6px; border-radius: 0 4px 4px 0; max-width: 520px; }
  .embed-author { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 13px; font-weight: 600; }
  .embed-title { font-weight: 600; color: var(--fg); margin-bottom: 4px; font-size: 14px; }
  .embed-desc { color: #dcddde; font-size: 14px; line-height: 1.4; margin-bottom: 6px; }
  .embed-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin-top: 6px; }
  .embed-field { font-size: 14px; }
  .embed-field.inline { display: inline-block; }
  .embed-field-name { font-weight: 600; color: var(--fg); display: block; margin-bottom: 2px; }
  .embed-footer { font-size: 12px; color: var(--fg-muted); margin-top: 6px; }
  .embed-image { margin-top: 8px; max-width: 100%; border-radius: 4px; }
  .reactions { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
  .reaction { background: #2b2d31; border: 1px solid #3f4147; padding: 2px 6px; border-radius: 8px; font-size: 13px; display: inline-flex; gap: 4px; align-items: center; }
  .reaction .emoji { width: 16px; height: 16px; }
  .reaction .count { color: var(--fg-muted); }
  .att { margin-top: 4px; font-size: 13px; color: var(--link); }
  .att img { max-width: 360px; max-height: 240px; border-radius: 4px; margin-top: 4px; display: block; }
  .sys { color: var(--fg-muted); font-style: italic; font-size: 13px; padding: 4px 20px; }
  footer.bottom { padding: 16px 24px; text-align: center; color: var(--fg-dim); font-size: 12px; border-top: 1px solid #1e1f22; }
</style>
</head>
<body>
${header}
<main>
  ${rows || '<div class="sys">Nessun messaggio in questo canale.</div>'}
</main>
<footer class="bottom">Trascrizione generata da NextBot · ${exportedAt}</footer>
</body>
</html>`;
}

function renderHeader(channel, messages, ticket) {
  const guildName = channel.guild ? escapeText(channel.guild.name) : 'DM';
  const channelName = escapeText(channel.name || 'canale');
  const firstUserMsg = messages.find((m) => !m.system && !m.author?.bot);
  const openerTag = firstUserMsg ? displayTag(firstUserMsg.author) : 'sconosciuto';
  const openerId = firstUserMsg?.author?.id || '?';
  const createdAt = channel.createdAt ? escapeText(new Date(channel.createdAt).toLocaleString('it-IT')) : '?';
  const lastAt = messages.length ? escapeText(new Date(messages[messages.length - 1].createdAt).toLocaleString('it-IT')) : createdAt;

  let html = `<header class="ticket">
  <h1>Ticket · #${channelName}</h1>
  <div class="meta">`;
  if (ticket) {
    html += `<span class="pill">${ticket.closed ? 'chiuso' : 'aperto'}</span>`;
    html += `<span>ID: <code>#${escapeText(String(ticket.id || ''))}</code></span> · `;
  }
  html += `<span>Server: ${guildName}</span> · `;
  html += `<span>Creato: ${createdAt}</span> · `;
  html += `<span>Ultimo msg: ${lastAt}</span><br>`;
  html += `<span>Aperto da: <strong>${escapeText(openerTag)}</strong> (${escapeText(openerId)})</span> · `;
  html += `<span>${messages.length} messaggi</span>`;
  html += `</div></header>`;
  return html;
}

function renderMessage(msg, prev) {
  if (msg.system) {
    return `<div class="sys">${escapeText(getSystemText(msg))}</div>`;
  }

  const author = msg.author || { username: 'sconosciuto', discriminator: '0', bot: false };
  const continued = prev
    && !prev.system
    && prev.author?.id === author.id
    && (msg.createdTimestamp - prev.createdTimestamp) < 7 * 60 * 1000; // 7 min
  const isMentioned = msg.mentions?.has?.(msg.guild?.members?.me?.id);
  const classes = ['msg'];
  if (continued) classes.push('continued');
  if (isMentioned) classes.push('mentioned');

  const ts = formatTimestamp(msg.createdAt);
  const body = renderContent(msg);
  const embeds = (msg.embeds || []).map(renderEmbed).join('');
  const attachments = renderAttachments(msg);
  const reactions = renderReactions(msg);
  const reply = renderReply(msg);

  const avatar = avatarUrl(author);
  const avatarBlock = avatar
    ? `<div class="avatar"><img src="${escapeAttr(avatar)}" alt="" loading="lazy"></div>`
    : `<div class="avatar"></div>`;

  return `<div class="${classes.join(' ')}" id="msg-${escapeAttr(msg.id)}">
  ${avatarBlock}
  <div class="body">
    <div class="header">
      <span class="author">${escapeText(displayTag(author))}</span>
      ${author.bot ? '<span class="bot-tag">BOT</span>' : ''}
      <span class="ts">${escapeText(ts)}</span>
      ${msg.editedAt ? `<span class="edited">(modificato)</span>` : ''}
    </div>
    ${reply}
    ${body}
    ${embeds}
    ${attachments}
    ${reactions}
  </div>
</div>`;
}

function renderReply(msg) {
  if (!msg.reference) return '';
  const refId = msg.reference.messageId;
  return `<div class="sys" style="padding-left:0;">↳ Risponde a <a href="#msg-${escapeAttr(refId)}">un messaggio</a></div>`;
}

function renderContent(msg) {
  if (!msg.content) return '';
  return `<div class="content">${renderMarkdown(msg.content)}</div>`;
}

function renderMarkdown(text) {
  let s = escapeText(text);
  // Codeblock ``` prima (per non mangiare il contenuto dentro con altri replace)
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.replace(/\\n/g, '\n')}</code></pre>`);
  // Inline code
  s = s.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  // Bold / italic / underline / strikethrough / spoiler
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/__([^_\n]+)__/g, '<u>$1</u>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  s = s.replace(/\|\|([^|\n]+)\|\|/g, '<span class="spoiler" onclick="this.classList.toggle(\'revealed\')">$1</span>');
  // Quote > prima riga
  s = s.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // Mention <@id> e <@&id> e <#id>
  s = s.replace(/&lt;@!?(\d+)&gt;/g, '<span class="mention">@utente</span>');
  s = s.replace(/&lt;@&amp;?(\d+)&gt;/g, '<span class="mention">@ruolo</span>');
  s = s.replace(/&lt;#(\d+)&gt;/g, '<span class="mention">#canale</span>');
  // URL (Discord: <url|label>)
  s = s.replace(/&lt;(https?:\/\/[^\s|&]+?)(?:\|([^&]+?))?&gt;/g, (_, url, label) => `<a href="${escapeAttr(url)}">${escapeText(label || url)}</a>`);
  return s;
}

function renderEmbed(embed) {
  let html = `<div class="embed" style="border-left-color: ${embedColor(embed.color)}">`;
  if (embed.author?.name) {
    const authorIcon = embed.author.iconURL ? `<img src="${escapeAttr(embed.author.iconURL)}" style="width:20px;height:20px;border-radius:50%;" alt="">` : '';
    html += `<div class="embed-author">${authorIcon}<span>${escapeText(embed.author.name)}</span></div>`;
  }
  if (embed.title) {
    const title = embed.url
      ? `<a href="${escapeAttr(embed.url)}">${escapeText(embed.title)}</a>`
      : escapeText(embed.title);
    html += `<div class="embed-title">${title}</div>`;
  }
  if (embed.description) {
    html += `<div class="embed-desc">${renderMarkdown(embed.description)}</div>`;
  }
  if (Array.isArray(embed.fields) && embed.fields.length) {
    html += '<div class="embed-fields">';
    for (const f of embed.fields) {
      const cls = `embed-field${f.inline ? ' inline' : ''}`;
      html += `<div class="${cls}"><span class="embed-field-name">${escapeText(f.name)}</span>${renderMarkdown(f.value || '')}</div>`;
    }
    html += '</div>';
  }
  if (embed.image?.url) {
    html += `<img class="embed-image" src="${escapeAttr(embed.image.url)}" alt="">`;
  }
  if (embed.thumbnail?.url && !embed.image?.url) {
    html += `<img class="embed-image" src="${escapeAttr(embed.thumbnail.url)}" alt="" style="max-width:80px;float:right;margin-left:8px;">`;
  }
  if (embed.footer?.text) {
    const footerIcon = embed.footer.iconURL ? `<img src="${escapeAttr(embed.footer.iconURL)}" style="width:14px;height:14px;border-radius:50%;" alt=""> ` : '';
    html += `<div class="embed-footer">${footerIcon}${escapeText(embed.footer.text)}</div>`;
  }
  if (embed.timestamp) {
    const ts = escapeText(new Date(embed.timestamp).toLocaleString('it-IT'));
    html += `<div class="embed-footer">${ts}</div>`;
  }
  html += '</div>';
  return html;
}

function renderAttachments(msg) {
  if (!msg.attachments || msg.attachments.size === 0) return '';
  const parts = [];
  for (const att of msg.attachments.values()) {
    const isImage = (att.contentType || '').startsWith('image/');
    let block = `<div class="att">📎 <strong>${escapeText(att.name || 'allegato')}</strong>`;
    block += ` — <a href="${escapeAttr(att.url)}">apri</a>`;
    if (att.size) block += ` · ${formatBytes(att.size)}`;
    block += `</div>`;
    if (isImage) {
      block += `<a href="${escapeAttr(att.url)}"><img src="${escapeAttr(att.url)}" alt="${escapeAttr(att.name || '')}"></a>`;
    }
    parts.push(block);
  }
  return parts.join('');
}

function renderReactions(msg) {
  if (!msg.reactions || msg.reactions.cache?.size === 0) return '';
  const parts = [];
  for (const r of msg.reactions.cache.values()) {
    const emoji = r.emoji;
    let e;
    if (emoji.id) {
      const ext = emoji.animated ? 'gif' : 'png';
      e = `<img class="emoji" src="https://cdn.discordapp.com/emojis/${emoji.id}.${ext}" alt="">`;
    } else {
      e = `<span class="emoji">${escapeText(emoji.name)}</span>`;
    }
    parts.push(`<div class="reaction">${e}<span class="count">${r.count}</span></div>`);
  }
  return parts.length ? `<div class="reactions">${parts.join('')}</div>` : '';
}

function embedColor(color) {
  if (color == null) return '#5865f2';
  return '#' + color.toString(16).padStart(6, '0');
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatTimestamp(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getSystemText(msg) {
  if (msg.type === 1) {
    const who = escapeText(msg.author?.username || 'qualcuno');
    const target = escapeText(msg.mentions?.users?.first()?.username || 'un utente');
    return `${who} ha aggiunto ${target} al canale.`;
  }
  if (msg.type === 2) {
    return `${escapeText(msg.author?.username || 'qualcuno')} è uscito dal canale.`;
  }
  if (msg.type === 4) {
    return `${escapeText(msg.author?.username || 'qualcuno')} ha cambiato nome.`;
  }
  if (msg.type === 7) {
    return `${escapeText(msg.author?.username || 'qualcuno')} ha pinnato un messaggio.`;
  }
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
  return String(s).replace(/"/g, '&quot;').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { build, filename, renderHtml };
