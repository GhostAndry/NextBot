'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const os = require('os');
const process = require('process');
const repo = require('../../db/repo');

// Comando diagnostico riservato al dev del bot. Mostra:
//   - uptime del processo Node
//   - uso memoria RSS / heap
//   - versione discord.js + Node
//   - ping del gateway Discord
//   - numero di guild connesse
//   - esito di una query Prisma di smoke test (SELECT 1)
//
// Chiunque altro può vedere il comando registrato, ma l'execute rifiuta
// chiunque non sia il DEV_USER_ID.

const DEV_USER_ID = '971512136490700900';

const data = new SlashCommandBuilder()
  .setName('health')
  .setDescription('Diagnostica del bot (solo dev)');

async function execute(interaction) {
  if (interaction.user.id !== DEV_USER_ID) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('❌ Non autorizzato').setDescription('Questo comando è riservato al dev del bot.').setTimestamp()],
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const uptimeSec = Math.floor(process.uptime());
  const mem = process.memoryUsage();
  const cpus = os.cpus() || [];
  const cpuModel = cpus[0]?.model || 'unknown';
  const loadAvg = os.loadavg();

  let dbOk = false;
  let dbLatencyMs = null;
  try {
    const t0 = Date.now();
    await repo.prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - t0;
    dbOk = true;
  } catch (err) {
    dbOk = false;
    dbLatencyMs = err.message;
  }

  const client = interaction.client;
  const embed = new EmbedBuilder()
    .setColor(dbOk ? 0x57f287 : 0xed4245)
    .setTitle('🩺 Bot Health')
    .addFields(
      { name: '⏱️ Uptime', value: formatUptime(uptimeSec), inline: true },
      { name: '📡 Gateway ping', value: `${client.ws.ping} ms`, inline: true },
      { name: '🌐 Guild', value: `${client.guilds.cache.size}`, inline: true },
      { name: '💾 RSS', value: `${Math.round(mem.rss / 1024 / 1024)} MB`, inline: true },
      { name: '🧠 Heap used', value: `${Math.round(mem.heapUsed / 1024 / 1024)} MB`, inline: true },
      { name: '📊 Heap total', value: `${Math.round(mem.heapTotal / 1024 / 1024)} MB`, inline: true },
      { name: '🖥️ CPU', value: cpuModel.slice(0, 60), inline: false },
      { name: '⚖️ Load avg (1/5/15)', value: loadAvg.map((v) => v.toFixed(2)).join(' / '), inline: true },
      { name: '🗄️ DB smoke test', value: dbOk ? `✅ OK (${dbLatencyMs} ms)` : `❌ ${dbLatencyMs}`, inline: true },
      { name: '🟢 Node', value: process.version, inline: true },
      { name: '📚 discord.js', value: require('discord.js').version, inline: true },
      { name: '🏓 Shard', value: `WS status ${client.ws.status}`, inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

module.exports = { data, execute };
