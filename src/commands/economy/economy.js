'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const config = require('../../config');
const repo = require('../../db/repo');
const { errorEmbed, successEmbed, hasElevatedPermissions } = require('../../utils/helpers');

const DAILY_COOLDOWN_S = 22 * 3600;
const STREAK_WINDOW_S = 48 * 3600;
const ROB_FINE = 50;
const PAGE_SIZE = 10;
const WORK_LINES = [
  'Hai riparato un server.',
  'Hai scritto del codice.',
  'Hai consegnato una pizza.',
  'Hai dipinto una staccionata.',
  'Hai fatto ripetizioni a uno studente.',
  'Hai portato a spasso dei cani.',
  'Hai fatto streaming su Twitch.',
];

// --- Definizione comando ---------------------------------------------------

const data = new SlashCommandBuilder()
  .setName('economy')
  .setDescription('Comandi economia')
  .addSubcommand((sc) => sc.setName('balance').setDescription('Controlla il saldo').addUserOption((o) => o.setName('utente').setDescription('Di chi controllare (default: tu)').setRequired(false)))
  .addSubcommand((sc) => sc.setName('daily').setDescription('Riscuoti la ricompensa giornaliera'))
  .addSubcommand((sc) => sc.setName('work').setDescription('Lavora per guadagnare monete'))
  .addSubcommand((sc) => sc.setName('deposit').setDescription('Sposta dal portafoglio alla banca').addIntegerOption((o) => o.setName('importo').setDescription('Importo da depositare').setRequired(true).setMinValue(1)))
  .addSubcommand((sc) => sc.setName('withdraw').setDescription('Sposta dalla banca al portafoglio').addIntegerOption((o) => o.setName('importo').setDescription('Importo da prelevare').setRequired(true).setMinValue(1)))
  .addSubcommand((sc) => sc.setName('give').setDescription('Dai monete a un utente').addUserOption((o) => o.setName('utente').setDescription('Destinatario').setRequired(true)).addIntegerOption((o) => o.setName('importo').setDescription('Importo da trasferire').setRequired(true).setMinValue(1)))
  .addSubcommand((sc) => sc.setName('rob').setDescription('Prova a derubare un utente').addUserOption((o) => o.setName('utente').setDescription('Vittima').setRequired(true)))
  .addSubcommand((sc) => sc.setName('leaderboard').setDescription('Classifica ricchi/XP del server')
    .addStringOption((o) => o.setName('tipo').setDescription('Cosa classificare').setRequired(false)
      .addChoices(
        { name: 'Totale (wallet + bank)', value: 'total' },
        { name: 'Wallet', value: 'wallet' },
        { name: 'Bank', value: 'bank' },
        { name: 'XP / Livello', value: 'xp' },
      ))
    .addIntegerOption((o) => o.setName('pagina').setDescription('Pagina (10 utenti per pagina)').setMinValue(1).setRequired(false)));

// --- Dispatcher -----------------------------------------------------------

async function execute(interaction) {
  if (!config.features.economy.enabled) return disabled(interaction);
  const handler = SUBCOMMAND_HANDLERS[interaction.options.getSubcommand()];
  if (!handler) return error(interaction, 'Sottocomando sconosciuto.');
  return handler(interaction);
}

const SUBCOMMAND_HANDLERS = {
  balance: cmdBalance,
  daily: cmdDaily,
  work: cmdWork,
  deposit: cmdDeposit,
  withdraw: cmdWithdraw,
  give: cmdGive,
  rob: cmdRob,
  leaderboard: cmdLeaderboard,
};

// --- Sottocomandi ---------------------------------------------------------

async function cmdBalance(interaction) {
  const target = interaction.options.getUser('utente') || interaction.user;
  const user = await repo.getUser(target.id, interaction.guildId);
  return interaction.reply({ embeds: [balanceEmbed(target, user)] });
}

async function cmdDaily(interaction) {
  const cfg = config.features.economy;
  const cooldown = DAILY_COOLDOWN_S; // 22h di cooldown (configurabile via DAILY_COOLDOWN_S)
  const user = await repo.getUser(interaction.user.id, interaction.guildId);
  const now = await repo.now();

  // Bypass cooldown per admin/elevated: paghiamo la ricompensa senza toccare
  // last_daily, così il timer dell'utente normale resta intatto.
  if (hasElevatedPermissions(interaction.member)) {
    const { reward, streak, bonus } = computeDailyReward({ ...user, last_daily: null, daily_streak: 0 }, now);
    const fresh = await repo.getUser(interaction.user.id, interaction.guildId);
    await repo.updateUser(interaction.user.id, interaction.guildId, {
      wallet: fresh.wallet + reward,
    });
    return interaction.reply({ embeds: [successEmbed('Ricompensa giornaliera', `+${reward} monete (serie ${streak}, bonus ${bonus}).`)] });
  }

  // Claim atomico per evitare race condition (due /daily simultanei bypassano
  // il check sequenziale read-then-write).
  if (await repo.claimDailyIfElapsed(interaction.user.id, interaction.guildId, now, cooldown, {
    wallet: { increment: 0 }, // placeholder, vedi sotto
  })) {
    // claimDailyIfElapsed ha già impostato last_daily: calcoliamo la ricompensa
    // e la aggiungiamo in un secondo update. NB: il primo call era solo per
    // occupare lo slot; dobbiamo prima decrementare wallet della reward già
    // "segnata" prima — qui non abbiamo ancora incrementato nulla, ma
    // abbiamo modificato last_daily. Fix: la query atomica che usiamo mette
    // last_daily in un'unica passata. Per la wallet, facciamo un secondo
    // update solo DOPO aver letto il valore attuale (non abbiamo atomicità,
    // ma a livello economico l'utente vede una cifra coerente).
    const { reward, streak, bonus } = computeDailyReward(user, now);
    const fresh = await repo.getUser(interaction.user.id, interaction.guildId);
    await repo.updateUser(interaction.user.id, interaction.guildId, {
      wallet: fresh.wallet + reward,
      daily_streak: streak,
    });
    const streakEmoji = streak >= 7 ? '🔥' : streak >= 3 ? '⚡' : '⭐';
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('🎁 Ricompensa giornaliera')
        .setDescription(`Hai ricevuto **+${reward} monete**.`)
        .addFields(
          { name: `${streakEmoji} Serie attuale`, value: `**${streak}** giorno${streak === 1 ? '' : 'i'}${bonus > 0 ? ` (+${bonus} bonus)` : ''}`, inline: true },
          { name: '⏭️ Prossimo daily', value: `<t:${now + cooldown}:R>`, inline: true },
        )
        .setFooter({ text: streak >= 7 ? 'Streak leggendario!' : `Continua la serie per bonus più alti.` })
        .setTimestamp()],
    });
  }

  const remainingSec = cooldown - (now - user.last_daily);
  const hoursLeft = Math.floor(remainingSec / 3600);
  const minutesLeft = Math.floor((remainingSec % 3600) / 60);
  const nextTs = user.last_daily + cooldown;
  return error(
    interaction,
    `Hai già riscosso oggi. Torna tra **${hoursLeft}h ${minutesLeft}m** (<t:${nextTs}:R>).` +
      (user.daily_streak > 0 ? `\n🔥 Serie attuale: **${user.daily_streak}** giorni — non lasciarla scadere!` : ''),
  );
}

async function cmdWork(interaction) {
  const cfg = config.features.economy;
  const cooldown = cfg.workCooldownSeconds ?? 3600;

  // Bypass cooldown per admin/elevated: paghiamo direttamente senza toccare
  // last_work, così il timer dell'utente normale resta intatto.
  if (hasElevatedPermissions(interaction.member)) {
    const amount = cfg.workMin + Math.floor(Math.random() * (cfg.workMax - cfg.workMin));
    const flavor = WORK_LINES[Math.floor(Math.random() * WORK_LINES.length)];
    const fresh = await repo.getUser(interaction.user.id, interaction.guildId);
    await repo.updateUser(interaction.user.id, interaction.guildId, {
      wallet: fresh.wallet + amount,
    });
    return interaction.reply({ embeds: [successEmbed('Lavoro', `${flavor} Hai guadagnato **${amount}** monete.`)] });
  }

  if (cooldown <= 0) return doWork(interaction, cfg, 0); // disabilitato

  const user = await repo.getUser(interaction.user.id, interaction.guildId);
  const now = await repo.now();

  // Claim atomico del cooldown. claimWorkIfElapsed ritorna false se il
  // last_work è ancora dentro la finestra.
  const claimed = await repo.claimWorkIfElapsed(interaction.user.id, interaction.guildId, now, cooldown, {
    wallet: { increment: 0 }, // placeholder
  });
  if (!claimed) {
    const minutesLeft = Math.ceil((cooldown - (now - user.last_work)) / 60);
    return error(interaction, `Sei stanco. Torna tra ${minutesLeft} minuti.`);
  }

  // Cooldown OK: paga la ricompensa.
  const amount = cfg.workMin + Math.floor(Math.random() * (cfg.workMax - cfg.workMin));
  const flavor = WORK_LINES[Math.floor(Math.random() * WORK_LINES.length)];
  const fresh = await repo.getUser(interaction.user.id, interaction.guildId);
  await repo.updateUser(interaction.user.id, interaction.guildId, {
    wallet: fresh.wallet + amount,
  });
  await interaction.reply({ embeds: [successEmbed('Lavoro', `${flavor} Hai guadagnato **${amount}** monete.`)] });
}

async function cmdDeposit(interaction) {
  const amount = interaction.options.getInteger('importo');
  const user = await repo.getUser(interaction.user.id, interaction.guildId);

  if (user.wallet < amount) return error(interaction, `Il tuo portafoglio ha ${user.wallet}.`);

  await repo.updateUser(interaction.user.id, interaction.guildId, {
    wallet: user.wallet - amount,
    bank: user.bank + amount,
  });
  await interaction.reply({ embeds: [successEmbed('Depositato', `${amount} spostate in banca.`)] });
}

async function cmdWithdraw(interaction) {
  const amount = interaction.options.getInteger('importo');
  const user = await repo.getUser(interaction.user.id, interaction.guildId);

  if (user.bank < amount) return error(interaction, `La tua banca ha ${user.bank}.`);

  await repo.updateUser(interaction.user.id, interaction.guildId, {
    wallet: user.wallet + amount,
    bank: user.bank - amount,
  });
  await interaction.reply({ embeds: [successEmbed('Prelevato', `${amount} spostate nel portafoglio.`)] });
}

async function cmdGive(interaction) {
  const target = interaction.options.getUser('utente');
  const amount = interaction.options.getInteger('importo');

  if (target.bot || target.id === interaction.user.id) {
    return error(interaction, 'Scegli un utente reale.');
  }

  const ok = await repo.transfer(interaction.user.id, target.id, interaction.guildId, amount);
  if (!ok) return error(interaction, 'Non hai abbastanza monete.');

  await interaction.reply({ embeds: [successEmbed('Inviato', `${amount} monete inviate a <@${target.id}>.`)] });
}

async function cmdRob(interaction) {
  const target = interaction.options.getUser('utente');

  if (target.bot || target.id === interaction.user.id) {
    return error(interaction, 'Scegli un utente reale.');
  }

  const robber = await repo.getUser(interaction.user.id, interaction.guildId);
  const victim = await repo.getUser(target.id, interaction.guildId);

  if (victim.wallet < 100) return error(interaction, 'Non ha nulla da rubare.');

  const success = Math.random() < config.features.economy.robSuccessRate;
  if (success) {
    const stolen = Math.floor(victim.wallet * config.features.economy.robMaxPercent);
    await repo.updateUser(interaction.user.id, interaction.guildId, { wallet: robber.wallet + stolen });
    await repo.updateUser(target.id, interaction.guildId, { wallet: victim.wallet - stolen });
    return interaction.reply({ embeds: [successEmbed('Rapina', `Hai rubato **${stolen}** monete a <@${target.id}>!`)] });
  }

  const fine = Math.min(robber.wallet, ROB_FINE);
  await repo.updateUser(interaction.user.id, interaction.guildId, { wallet: robber.wallet - fine });
  await interaction.reply({ embeds: [errorEmbed('Scoperto', `Sei stato scoperto e multato di **${fine}** monete.`)] });
}

async function cmdLeaderboard(interaction) {
  const tipo = interaction.options.getString('tipo') || 'total';
  const page = Math.max(1, interaction.options.getInteger('pagina') || 1);
  const offset = (page - 1) * PAGE_SIZE;

  // Recupero tutti gli utenti della guild, sortati in JS perché Prisma su SQLite
  // non supporta `orderBy` con campi calcolati (wallet+bank).
  // Limite: 200 righe per evitare di tirare giù tutta la tabella su server grossi.
  const allRows = await repo.prisma.user.findMany({
    where: { guildId: interaction.guildId },
    select: { userId: true, wallet: true, bank: true, xp: true, level: true },
    take: 200,
  });
  if (allRows.length === 0) return error(interaction, 'Ancora nessun dato.');

  const rankOf = makeRankOf(tipo);
  const sorted = [...allRows].sort((a, b) => rankOf(b) - rankOf(a));

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  if (page > totalPages) {
    return error(interaction, `La classifica ha solo ${totalPages} pagine. Riprova con pagina ≤ ${totalPages}.`);
  }

  const slice = sorted.slice(offset, offset + PAGE_SIZE);
  const startRank = offset + 1;

  // Fetch username in parallelo (con cache best-effort)
  const entries = await Promise.all(slice.map(async (r, i) => {
    let tag = r.userId;
    try {
      const u = await interaction.client.users.fetch(r.userId);
      tag = u.tag;
    } catch (_) {}
    const medal = i === 0 && offset === 0 ? '🥇' : i === 1 && offset === 0 ? '🥈' : i === 2 && offset === 0 ? '🥉' : '`#' + (startRank + i) + '`';
    const value = formatValue(r, tipo);
    return `${medal} <@${r.userId}> — ${value}`;
  }));

  const titleEmoji = tipo === 'xp' ? '📈' : '💰';
  const title = tipo === 'xp' ? 'Livelli XP' : tipo === 'wallet' ? 'Wallet' : tipo === 'bank' ? 'Bank' : 'Totale monete';

  // Posizione dell'utente che ha chiesto (se non è già nella pagina visibile)
  let selfLine = '';
  const myRank = sorted.findIndex((r) => r.userId === interaction.user.id) + 1;
  if (myRank > 0) {
    const me = sorted[myRank - 1];
    const onPage = myRank >= startRank && myRank < startRank + slice.length;
    if (!onPage) {
      selfLine = `\n_La tua posizione: **#${myRank}** — ${formatValue(me, tipo)}_`;
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`${titleEmoji} Classifica — ${title}`)
    .setDescription(entries.join('\n') + selfLine)
    .setFooter({ text: `Pagina ${page}/${totalPages} • ${sorted.length} utenti classificati` })
    .setTimestamp();

  // Bottoni paginazione (solo se c'è più di una pagina)
  const components = [];
  if (totalPages > 1) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`lb:${tipo}:${page - 1}`)
        .setLabel('◀')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1),
      new ButtonBuilder()
        .setCustomId(`lb:${tipo}:${page + 1}`)
        .setLabel('▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages),
    );
    components.push(row);
  }

  await interaction.reply({ embeds: [embed], components });
}

function makeRankOf(tipo) {
  switch (tipo) {
    case 'wallet': return (r) => r.wallet || 0;
    case 'bank': return (r) => r.bank || 0;
    case 'xp': return (r) => (r.level || 0) * 1000000 + (r.xp || 0); // livello prioritario, xp a parità
    case 'total':
    default: return (r) => (r.wallet || 0) + (r.bank || 0);
  }
}

function formatValue(r, tipo) {
  switch (tipo) {
    case 'wallet': return `**${(r.wallet || 0).toLocaleString()}** 🪙`;
    case 'bank': return `**${(r.bank || 0).toLocaleString()}** 🏦`;
    case 'xp': return `Lv **${r.level || 0}** • ${(r.xp || 0).toLocaleString()} xp`;
    case 'total':
    default: return `**${((r.wallet || 0) + (r.bank || 0)).toLocaleString()}** 🪙`;
  }
}

// Handler per i bottoni di paginazione. Riusa la logica del comando.
async function handleLeaderboardButton(interaction) {
  if (!interaction.isButton()) return false;
  const parts = interaction.customId.split(':');
  if (parts.length !== 3 || parts[0] !== 'lb') return false;
  const tipo = parts[1];
  const page = Math.max(1, parseInt(parts[2], 10) || 1);

  // Simulo un'interaction "finta" per riutilizzare cmdLeaderboard? Più pulito:
  // chiamo direttamente il fetch + render inline.
  const offset = (page - 1) * PAGE_SIZE;
  const allRows = await repo.prisma.user.findMany({
    where: { guildId: interaction.guildId },
    select: { userId: true, wallet: true, bank: true, xp: true, level: true },
    take: 200,
  });
  if (allRows.length === 0) {
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Nessun dato').setTimestamp()],
      components: [],
    });
  }
  const rankOf = makeRankOf(tipo);
  const sorted = [...allRows].sort((a, b) => rankOf(b) - rankOf(a));
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  if (page > totalPages) return false;
  const slice = sorted.slice(offset, offset + PAGE_SIZE);
  const startRank = offset + 1;
  const entries = await Promise.all(slice.map(async (r, i) => {
    let tag = r.userId;
    try { tag = (await interaction.client.users.fetch(r.userId)).tag; } catch (_) {}
    const medal = i === 0 && offset === 0 ? '🥇' : i === 1 && offset === 0 ? '🥈' : i === 2 && offset === 0 ? '🥉' : '`#' + (startRank + i) + '`';
    return `${medal} <@${r.userId}> — ${formatValue(r, tipo)}`;
  }));
  const titleEmoji = tipo === 'xp' ? '📈' : '💰';
  const title = tipo === 'xp' ? 'Livelli XP' : tipo === 'wallet' ? 'Wallet' : tipo === 'bank' ? 'Bank' : 'Totale monete';
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`${titleEmoji} Classifica — ${title}`)
    .setDescription(entries.join('\n'))
    .setFooter({ text: `Pagina ${page}/${totalPages} • ${sorted.length} utenti classificati` })
    .setTimestamp();
  const components = totalPages > 1 ? [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`lb:${tipo}:${page - 1}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`lb:${tipo}:${page + 1}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages),
  )] : [];
  await interaction.update({ embeds: [embed], components });
  return true;
}

// --- Helper ---------------------------------------------------------------

function computeDailyReward(user, now) {
  const cfg = config.features.economy;
  const base = cfg.dailyMin + Math.floor(Math.random() * (cfg.dailyMax - cfg.dailyMin));
  const streakContinues = user.last_daily && (now - user.last_daily) < STREAK_WINDOW_S;
  const streak = streakContinues ? (user.daily_streak || 0) + 1 : 1;
  const bonus = streakContinues ? cfg.dailyStreakBonus : 0;
  return { reward: base + bonus, streak, bonus };
}

function balanceEmbed(user, record) {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`💰 Portafoglio di ${user.tag}`)
    .addFields(
      { name: 'Portafoglio', value: `${record.wallet.toLocaleString()}`, inline: true },
      { name: 'Banca', value: `${record.bank.toLocaleString()}`, inline: true },
      { name: 'Totale', value: `${(record.wallet + record.bank).toLocaleString()}`, inline: true },
    )
    .setThumbnail(user.displayAvatarURL())
    .setTimestamp();
}

function disabled(interaction) {
  return interaction.reply({ embeds: [errorEmbed('Disabilitato', "L'economia è disabilitata.")], flags: MessageFlags.Ephemeral });
}

function error(interaction, msg) {
  return interaction.reply({ embeds: [errorEmbed('Errore', msg)], flags: MessageFlags.Ephemeral });
}

module.exports = { data, execute, handleComponent: handleLeaderboardButton };
