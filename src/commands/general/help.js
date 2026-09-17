'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { listCommands } = require('../../handlers/registry');
const { CATEGORIES, listByCategory } = require('../../handlers/categories');

const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Mostra tutti i comandi, raggruppati per categoria')
  .addStringOption((opt) =>
    opt.setName('categoria').setDescription('Mostra solo una categoria').setRequired(false)
      .addChoices(...Object.entries(CATEGORIES).map(([value, { label }]) => ({ name: label, value }))),
  )
  .addBooleanOption((opt) => opt.setName('tutto').setDescription('Mostra tutto (default false)').setRequired(false));

async function execute(interaction) {
  const category = interaction.options.getString('categoria');
  const showAll = interaction.options.getBoolean('tutto') || false;
  const grouped = listByCategory();
  const total = listCommands().length;

  if (category) {
    const entry = CATEGORIES[category];
    const lines = (grouped[category] || []).map((c) => `\`/${c.name}\` — ${c.description}`);
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`${entry.emoji} ${entry.label}`)
      .setDescription(lines.join('\n') || '_Nessun comando in questa categoria._')
      .setFooter({ text: `${lines.length} comandi` })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (!showAll) {
    const overview = Object.entries(CATEGORIES)
      .map(([key, { label, emoji }]) => {
        const count = (grouped[key] || []).length;
        return `${emoji} **${label}** — ${count} comando${count === 1 ? '' : 'i'}`;
      })
      .join('\n');
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('NextBot — Comandi')
      .setDescription(overview + `\n\nUsa \`/help categoria:<nome>\` o \`/help tutto:true\` per i dettagli.`)
      .setFooter({ text: `${total} comandi totali` })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  const pages = Object.entries(CATEGORIES).map(([key, { label, emoji }]) => {
    const lines = (grouped[key] || []).map((c) => `\`/${c.name}\` — ${c.description}`);
    return new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`${emoji} ${label}`)
      .setDescription(lines.join('\n') || '_vuota_')
      .setFooter({ text: `${total} comandi totali` });
  });
  await interaction.reply({ embeds: pages, flags: MessageFlags.Ephemeral });
}

module.exports = { data, execute };
