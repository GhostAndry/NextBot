'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('fun')
  .setDescription('Comandi divertenti')
  .addSubcommand((sc) => sc.setName('8ball').setDescription('Chiedi alla palla magica').addStringOption((o) => o.setName('domanda').setDescription('La tua domanda').setRequired(true)))
  .addSubcommand((sc) => sc.setName('coinflip').setDescription('Lancia una moneta'))
  .addSubcommand((sc) => sc.setName('dice').setDescription('Lancia i dadi').addIntegerOption((o) => o.setName('facce').setDescription('Numero di facce (default 6)').setMinValue(2).setMaxValue(100).setRequired(false)).addIntegerOption((o) => o.setName('quantita').setDescription('Quanti dadi (default 1)').setMinValue(1).setMaxValue(10).setRequired(false)))
  .addSubcommand((sc) => sc.setName('rps').setDescription('Carta forbice sasso').addStringOption((o) => o.setName('scelta').setDescription('La tua mossa').setRequired(true).addChoices({ name: 'sasso', value: 'rock' }, { name: 'carta', value: 'paper' }, { name: 'forbice', value: 'scissors' })))
  .addSubcommand((sc) => sc.setName('choose').setDescription('Scegline uno').addStringOption((o) => o.setName('opzioni').setDescription('Opzioni separate da virgola').setRequired(true)))
  .addSubcommand((sc) => sc.setName('rate').setDescription('Dai un voto').addStringOption((o) => o.setName('cosa').setDescription('Cosa valutare').setRequired(true)))
  .addSubcommand((sc) => sc.setName('howgay').setDescription('Quanto sei gay?').addUserOption((o) => o.setName('utente').setDescription('Di chi misurare (default: tu)').setRequired(false)))
  .addSubcommand((sc) => sc.setName('pp').setDescription('Dimensione pp').addUserOption((o) => o.setName('utente').setDescription('Di chi misurare (default: tu)').setRequired(false)));

const BALL = ['È certo.', 'Senza dubbio.', 'Decisamente sì.', 'Puoi contarci.', 'Molto probabile.', 'Le premesse sono buone.', 'Sì.', 'I segnali dicono di sì.', 'Risposta confusa, riprova.', 'Chiedi più tardi.', 'Meglio non dirtelo ora.', 'Impossibile prevederlo ora.', 'Concentrati e chiedi ancora.', 'Non contarci.', 'La mia risposta è no.', 'Le premesse non sono buone.', 'Molto dubbioso.'];

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  switch (sub) {
    case '8ball': return eightBall(interaction);
    case 'coinflip': return coinflip(interaction);
    case 'dice': return dice(interaction);
    case 'rps': return rps(interaction);
    case 'choose': return choose(interaction);
    case 'rate': return rate(interaction);
    case 'howgay': return howgay(interaction);
    case 'pp': return pp(interaction);
  }
}

async function eightBall(interaction) {
  const q = interaction.options.getString('domanda');
  const answer = BALL[Math.floor(Math.random() * BALL.length)];
  const e = new EmbedBuilder().setColor(0x5865f2).setTitle('🎱 Palla magica').addFields({ name: 'D', value: q }, { name: 'R', value: `**${answer}**` });
  await interaction.reply({ embeds: [e] });
}

async function coinflip(interaction) {
  const result = Math.random() < 0.5 ? 'Testa' : 'Croce';
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle(`🪙 ${result}`)] });
}

async function dice(interaction) {
  const sides = interaction.options.getInteger('facce') || 6;
  const count = interaction.options.getInteger('quantita') || 1;
  const rolls = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const r = 1 + Math.floor(Math.random() * sides);
    rolls.push(r);
    total += r;
  }
  const e = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`🎲 ${count}d${sides}`)
    .setDescription(`Lanci: ${rolls.join(', ')}\nTotale: **${total}**`);
  await interaction.reply({ embeds: [e] });
}

async function rps(interaction) {
  const choice = interaction.options.getString('scelta');
  const choices = ['rock', 'paper', 'scissors'];
  const bot = choices[Math.floor(Math.random() * 3)];
  const NOMI = { rock: 'sasso', paper: 'carta', scissors: 'forbice' };
  let result;
  if (choice === bot) result = 'Pareggio!';
  else if ((choice === 'rock' && bot === 'scissors') || (choice === 'paper' && bot === 'rock') || (choice === 'scissors' && bot === 'paper')) result = 'Hai vinto!';
  else result = 'Hai perso!';
  const e = new EmbedBuilder().setColor(0x5865f2).setTitle('🪨 Carta forbice sasso').setDescription(`Tu: **${NOMI[choice]}**\nBot: **${NOMI[bot]}**\n\n**${result}**`);
  await interaction.reply({ embeds: [e] });
}

async function choose(interaction) {
  const options = interaction.options.getString('opzioni').split(',').map((s) => s.trim()).filter(Boolean);
  if (options.length < 2) return interaction.reply({ content: 'Dammi almeno 2 opzioni.', flags: MessageFlags.Ephemeral });
  const picked = options[Math.floor(Math.random() * options.length)];
  await interaction.reply(`Scelgo **${picked}**!`);
}

async function rate(interaction) {
  const thing = interaction.options.getString('cosa');
  const score = Math.floor(Math.random() * 11);
  await interaction.reply(`Valuto **${thing}** un **${score}/10**.`);
}

async function howgay(interaction) {
  const user = interaction.options.getUser('utente') || interaction.user;
  const score = Math.floor(seededRandom(user.id) * 101);
  await interaction.reply(`🏳️‍🌈 ${user.tag} è **${score}%** gay.`);
}

async function pp(interaction) {
  const user = interaction.options.getUser('utente') || interaction.user;
  const size = Math.floor(seededRandom(user.id + 'pp') * 15) + 1;
  const bars = '═'.repeat(size);
  await interaction.reply(`🍆 Il pp di ${user.tag}:\n8${bars}D`);
}

function seededRandom(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h << 5) - h + str.charCodeAt(i);
  return Math.abs(Math.sin(h) * 10000) % 1;
}

module.exports = { data, execute };
