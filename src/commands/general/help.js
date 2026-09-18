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
    const lines = (grouped[category] || []).map((c) => formatCommand(c));
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
        const subs = (grouped[key] || []).reduce((n, c) => n + (c.subs?.length || 0), 0);
        return `${emoji} **${label}** — ${count} comando${count === 1 ? '' : 'i'}${subs ? `, ${subs} sub` : ''}`;
      })
      .join('\n');
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('NextBot — Comandi')
      .setDescription(
        overview +
          `\n\nUsa \`/help categoria:<nome>\` per il dettaglio di una categoria, ` +
          `oppure \`/help tutto:true\` per l'elenco completo.`
      )
      .setFooter({ text: `${total} comandi totali` })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  const pages = Object.entries(CATEGORIES).map(([key, { label, emoji }]) => {
    const lines = (grouped[key] || []).map((c) => formatCommand(c));
    return new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`${emoji} ${label}`)
      .setDescription(lines.join('\n') || '_vuota_')
      .setFooter({ text: `${total} comandi totali` });
  });
  await interaction.reply({ embeds: pages, flags: MessageFlags.Ephemeral });
}

function formatCommand(cmd) {
  const head = `\`/${cmd.name}\` — ${cmd.description}`;
  if (!cmd.subs || cmd.subs.length === 0) return head;
  const subLines = cmd.subs.map((s) => `  • \`/${cmd.name} ${s.name}\` — ${s.description}`);
  return [head, ...subLines].join('\n');
}

module.exports = { data, execute };
