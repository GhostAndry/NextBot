'use strict';

// /halloween hunt - Bug Hunting
// "Caccia il bug nel codice": ogni round mostra uno snippet con bug nascosti.
// L'utente clicca i token che ritiene siano bug. Risposte corrette = monete,
// moltiplicatore che cresce con gli streak. Risposte sbagliate = perdi il
// moltiplicatore (o parte delle monete) e il round finisce.
//
// Lo snippet è presentato come codice formattato in un code block embed.
// I token "interessanti" sono anche bottoni con un indice numerico; quando
// l'utente clicca un bottone, il sistema controlla se quell'indice fa parte
// dei bug veri del round.
//
// Round templates: array di oggetti { code: [[ {t, type} ]], bugs: [indices] }.
// type: 'normal' | 'bug' | 'safe'. Solo i 'bug' sono risposte corrette.

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const { randomUUID } = require('crypto');
const config = require('../../config');
const repo = require('../../db/repo');
const { errorEmbed, successEmbed } = require('../../utils/helpers');

const CMD = 'halloween';
const GAME = 'bughunt';

const data = new SlashCommandBuilder()
  .setName(CMD)
  .setDescription('Mini-giochi a tema Halloween')
  .addSubcommand((sc) => sc.setName('hunt').setDescription('Avvia un round di Bug Hunting'));

const cooldowns = new Map();
const COOLDOWN_KEY = (uid, gid) => `${gid}:${uid}`;

function getCfg() {
  return config.features.economy?.bughunt || {};
}

function betAmount() {
  return getCfg().bet ?? 50;
}

function cooldownSeconds() {
  return getCfg().cooldownSeconds ?? 60;
}

function isEnabled() {
  return Boolean(getCfg().enabled);
}

// --- Snippet templates ------------------------------------------------------
//
// Ogni snippet è una serie di righe, ogni riga è un array di token.
// Ogni token ha:
//   t: il testo visibile
//   type: 'bug' (la risposta corretta) o 'safe' (distrattore o codice normale)
// 'bug' è la risposta; tutto il resto è distractor.
// L'utente vede il codice "come codice" e clicca i token che gli sembrano bug.

const SNIPPETS = [
  {
    language: 'js',
    title: 'Async repository',
    code: [
      [
        { t: 'async', type: 'safe' }, { t: ' ', type: 'safe' },
        { t: 'function', type: 'safe' }, { t: ' ', type: 'safe' },
        { t: 'getUser(id)', type: 'safe' }, { t: ' ', type: 'safe' },
        { t: '{', type: 'safe' },
      ],
      [
        { t: '  ', type: 'safe' },
        { t: 'return', type: 'safe' }, { t: ' ', type: 'safe' },
        { t: 'prisma.user.findFirst(id)', type: 'bug' },
        { t: ';', type: 'safe' },
      ],
      [
        [
          { t: '}', type: 'safe' },
        ],
      ],
    ],
    hint: 'findFirst vuole un argomento `where`, non l\'ID diretto.',
  },
  {
    language: 'js',
    title: 'Cooldown check',
    code: [
      [
        { t: 'if', type: 'safe' }, { t: ' ', type: 'safe' },
        { t: '(now - last < 60000) {', type: 'bug' },
      ],
      [
        { t: '  ', type: 'safe' },
        { t: 'return', type: 'safe' }, { t: ' ', type: 'safe' },
        { t: 'error(', type: 'safe' }, { t: '\'cooldown\'', type: 'safe' }, { t: ');', type: 'safe' },
      ],
      [
        { t: '}', type: 'safe' },
      ],
    ],
    hint: 'Manca la `)` di chiusura prima di `{`.',
  },
  {
    language: 'js',
    title: 'Embed builder',
    code: [
      [
        { t: 'const', type: 'safe' }, { t: ' ', type: 'safe' },
        { t: 'embed = new EmbedBuilder().setTitle(\'Ciao\')', type: 'bug' },
        { t: ';', type: 'safe' },
      ],
      [
        { t: 'embed.setColor(\'#ff0000\').setDescription(\'test\');', type: 'safe' },
      ],
    ],
    hint: 'setColor vuole un intero o un ColorResolvable, non una stringa con #.',
  },
  {
    language: 'js',
    title: 'For loop',
    code: [
      [
        { t: 'for', type: 'safe' }, { t: ' ', type: 'safe' },
        { t: '(let i = 0; i <= arr.length; i++) {', type: 'bug' },
      ],
      [
        { t: '  ', type: 'safe' },
        { t: 'console.log(arr[i]);', type: 'safe' },
      ],
      [
        { t: '}', type: 'safe' },
      ],
    ],
    hint: 'Off-by-one: con `<=` si sfora di 1. Dovrebbe essere `<`.',
  },
  {
    language: 'js',
    title: 'Await mancante',
    code: [
      [
        { t: 'async', type: 'safe' }, { t: ' ', type: 'safe' },
        { t: 'function', type: 'safe' }, { t: ' ', type: 'safe' },
        { t: 'run()', type: 'safe' }, { t: ' ', type: 'safe' },
        { t: '{', type: 'safe' },
      ],
      [
        { t: '  ', type: 'safe' },
        { t: 'const', type: 'safe' }, { t: ' ', type: 'safe' },
        { t: 'user = repo.getUser(id, guildId);', type: 'bug' },
      ],
      [
        { t: '  ', type: 'safe' },
        { t: 'console.log(user.wallet);', type: 'safe' },
      ],
      [
        { t: '}', type: 'safe' },
      ],
    ],
    hint: '`repo.getUser` è async: serve `await`.',
  },
  {
    language: 'js',
    title: 'Operatore confronto',
    code: [
      [
        { t: 'if', type: 'safe' }, { t: ' ', type: 'safe' },
        { t: '(role = \'admin\') {', type: 'bug' },
      ],
      [
        { t: '  ', type: 'safe' },
        { t: 'allowAccess();', type: 'safe' },
      ],
      [
        { t: '}', type: 'safe' },
      ],
    ],
    hint: 'Stai assegnando invece di confrontare. Serve `===`.',
  },
  {
    language: 'js',
    title: 'Return mancante',
    code: [
      [
        { t: 'function', type: 'safe' }, { t: ' ', type: 'safe' },
        { t: 'add(a, b) {', type: 'safe' },
      ],
      [
        { t: '  ', type: 'safe' },
        { t: 'a + b;', type: 'bug' },
      ],
      [
        { t: '}', type: 'safe' },
      ],
    ],
    hint: 'Calcola ma non ritorna nulla. Manca `return`.',
  },
  {
    language: 'js',
    title: 'String interpolation',
    code: [
      [
        { t: 'console.log(', type: 'safe' },
        { t: '`Ciao ${name}!`', type: 'safe' },
        { t: ');', type: 'safe' },
      ],
    ],
    hint: 'Questo snippet è corretto, non cliccare nulla.',
    noBug: true,
  },
];

function pickSnippet() {
  return SNIPPETS[Math.floor(Math.random() * SNIPPETS.length)];
}

// Mappa i token a indici "lineari" 0..N-1 per i customId dei bottoni.
function flatten(snippet) {
  const tokens = [];
  for (const line of snippet.code) {
    for (const tok of line) {
      tokens.push(tok);
    }
  }
  return tokens;
}

function buildCodeText(snippet, revealed) {
  // Mostra il codice come testo monospace dentro ``` ```.
  // I token rivelati come bug restano visibili normalmente; quelli corretti
  // sono già tutti visibili; quelli cliccati come "bug" sono evidenziati.
  const lines = [];
  for (const line of snippet.code) {
    let lineStr = '';
    for (const tok of line) {
      lineStr += tok.t;
    }
    lines.push(lineStr);
  }
  return lines.join('\n');
}

function buildEmbed(state, finished = false, lastResult = null) {
  const snippet = state.snippet;
  const cfg = getCfg();
  const header = finished
    ? (state.status === 'won' ? '✅ Round completato!' : '💀 Bug scovato.')
    : `🎃 Bug Hunting — moltiplicatore x${state.streak}`;
  const rewardLine = state.collected > 0
    ? `**Monete vinte:** ${state.collected}`
    : (finished && state.collected < 0 ? `**Penalità:** -${Math.abs(state.collected)}` : 'Inizia a cliccare i token sospetti.');

  const code = buildCodeText(snippet);
  const desc = [
    `**${snippet.title}** (\`${snippet.language}\`)`,
    '```js',
    code,
    '```',
    state.streak >= 2 ? `🔥 Streak: ${state.streak}` : null,
    rewardLine,
    finished ? `**Suggerimento:** ${snippet.hint}` : '💡 Clicca i token che ti sembrano un bug. Una risposta sbagliata = round finito.',
    lastResult ? lastResult : null,
  ].filter(Boolean).join('\n\n');

  return new EmbedBuilder()
    .setColor(finished ? (state.status === 'won' ? 0x57f287 : 0xed4245) : 0xfee75c)
    .setTitle(header)
    .setDescription(desc)
    .setFooter({ text: finished ? 'Round terminato' : 'Caccia il bug!' });
}

function buildTokenButtons(state) {
  const tokens = state.tokens;
  const rows = [];
  let row = new ActionRowBuilder();
  let inRow = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'bug') continue; // solo i "bug" sono cliccabili
    const btn = new ButtonBuilder()
      .setCustomId(`${CMD}:bug:${state.sessionId}:${i}`)
      .setLabel(`${i}`)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(state.finished);
    row.addComponents(btn);
    inRow++;
    if (inRow === 5) {
      rows.push(row);
      row = new ActionRowBuilder();
      inRow = 0;
    }
  }
  if (inRow > 0) rows.push(row);

  // Bottone "salta" (passa al prossimo round) in fondo.
  const skipRow = new ActionRowBuilder();
  skipRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`${CMD}:skip:${state.sessionId}`)
      .setLabel(state.streak >= 2 ? 'Cashout' : 'Skip')
      .setStyle(ButtonStyle.Success)
      .setDisabled(state.finished)
  );
  rows.push(skipRow);
  return rows;
}

async function execute(interaction) {
  if (!isEnabled()) return interaction.reply({ embeds: [errorEmbed('Disabilitato', 'Il Bug Hunting è disabilitato.')], flags: MessageFlags.Ephemeral });
  if (!config.features.economy?.enabled) return interaction.reply({ embeds: [errorEmbed('Errore', 'L\'economia è disabilitata.')], flags: MessageFlags.Ephemeral });

  const now = Date.now();
  const last = cooldowns.get(COOLDOWN_KEY(interaction.user.id, interaction.guildId)) || 0;
  const cd = cooldownSeconds();
  if (cd > 0 && now - last < cd * 1000) {
    const left = Math.ceil((cd * 1000 - (now - last)) / 1000);
    return interaction.reply({ embeds: [errorEmbed('Cooldown', `Torna tra ${left}s.`)], flags: MessageFlags.Ephemeral });
  }

  const user = await repo.getUser(interaction.user.id, interaction.guildId);
  if (user.wallet < betAmount()) {
    return interaction.reply({ embeds: [errorEmbed('Povero', `Servono almeno **${betAmount()}** monete in portafoglio.`)], flags: MessageFlags.Ephemeral });
  }
  await repo.updateUser(interaction.user.id, interaction.guildId, { wallet: user.wallet - betAmount() });

  cooldowns.set(COOLDOWN_KEY(interaction.user.id, interaction.guildId), Date.now());

  const snippet = pickSnippet();
  const state = {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    snippet,
    tokens: flatten(snippet),
    bet: betAmount(),
    collected: 0,
    streak: 1,
    status: 'playing',
    finished: false,
    sessionId: randomUUID(),
  };
  await repo.saveGameSession(state.sessionId, state.guildId, state.channelId, state.userId, GAME, state);

  await interaction.reply({
    embeds: [buildEmbed(state)],
    components: buildTokenButtons(state),
  });
}

async function handleComponent(interaction) {
  const m = (interaction.customId || '').split(':');
  if (m.length < 4 || m[0] !== CMD) return false;

  const sessionId = m[2];
  const action = m[1];

  const sess = await repo.getGameSession(sessionId);
  if (!sess || sess.game !== GAME) return false;
  const state = sess.state;
  if (state.userId !== interaction.user.id) {
    return interaction.reply({ embeds: [errorEmbed('Errore', 'Questa partita non è tua.')], flags: MessageFlags.Ephemeral });
  }
  if (state.finished) {
    return interaction.update({ embeds: [buildEmbed(state, true)], components: buildTokenButtons(state) });
  }

  if (action === 'skip') {
    return cashout(state, sessionId, interaction);
  }

  if (action === 'bug') {
    const idx = parseInt(m[3], 10);
    if (!Number.isInteger(idx)) return false;
    return judgeClick(state, sessionId, idx, interaction);
  }
  return false;
}

async function judgeClick(state, sessionId, idx, interaction) {
  const tok = state.tokens[idx];
  if (!tok) return false;

  // Lo snippet è un trick: nessun bug (tutto safe) → tutti i click sono sbagliati.
  if (state.snippet.noBug) {
    return endRound(state, sessionId, 'lost', interaction, '❌ Nessun bug in questo snippet! Hai cliccato un innocente.');
  }

  if (tok.type === 'bug') {
    // Corretto: +monete, +streak, genera nuovo round se streak > 1.
    const base = Math.max(10, Math.floor(state.bet * 0.5));
    const reward = base * state.streak;
    state.collected += reward;
    const user = await repo.getUser(state.userId, state.guildId);
    await repo.updateUser(state.userId, state.guildId, { wallet: user.wallet + reward });

    // Dopo un hit, il round è "vinto": generiamo un nuovo snippet con
    // moltiplicatore che sale. Manteniamo la stessa sessionId lato DB.
    state.streak += 1;
    const newSnippet = pickSnippet();
    // Evita di ripescare lo stesso snippet appena visto
    while (newSnippet === state.snippet) {
      const alt = pickSnippet();
      if (alt !== state.snippet) { state.snippet = alt; break; }
      break;
    }
    if (newSnippet !== state.snippet) state.snippet = newSnippet;
    state.tokens = flatten(state.snippet);
    state.finished = false;
    await repo.saveGameSession(sessionId, state.guildId, state.channelId, state.userId, GAME, state);
    return interaction.update({
      embeds: [buildEmbed(state, false, `✅ Bug trovato! +**${reward}** monete. Prossimo round: x${state.streak}.`)],
      components: buildTokenButtons(state),
    });
  }

  // Cliccato un safe → round finito, penalità.
  return endRound(state, sessionId, 'lost', interaction, '❌ Quello non è un bug. Hai perso.');
}

async function cashout(state, sessionId, interaction) {
  if (state.collected === 0) {
    // Niente da incassare, penalità pari al bet.
    return endRound(state, sessionId, 'lost', interaction, 'Saltato senza vincite: perdi il bet.');
  }
  state.status = 'won';
  state.finished = true;
  await repo.saveGameSession(sessionId, state.guildId, state.channelId, state.userId, GAME, state);
  return interaction.update({
    embeds: [buildEmbed(state, true, `💰 Cashout: **${state.collected}** monete incassate.`)],
    components: buildTokenButtons(state),
  });
}

async function endRound(state, sessionId, status, interaction, lastResult) {
  state.status = status;
  state.finished = true;
  // Penalità: se non hai vinto niente, perdi il bet (già detratto) e basta.
  // Non tocchiamo ulteriormente il wallet (bet già sottratto all'inizio).
  await repo.saveGameSession(sessionId, state.guildId, state.channelId, state.userId, GAME, state);
  return interaction.update({
    embeds: [buildEmbed(state, true, lastResult)],
    components: buildTokenButtons(state),
  });
}

module.exports = { data, execute, handleComponent, CMD };
