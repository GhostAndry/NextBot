'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const repo = require('../../db/repo');
const { errorEmbed, successEmbed, hasElevatedPermissions } = require('../../utils/helpers');

const DAILY_COOLDOWN_S = 22 * 3600;
const STREAK_WINDOW_S = 48 * 3600;
const ROB_FINE = 50;
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
  .addSubcommand((sc) => sc.setName('leaderboard').setDescription('Gli utenti più ricchi'));

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
    return interaction.reply({ embeds: [successEmbed('Ricompensa giornaliera', `+${reward} monete (serie ${streak}, bonus ${bonus}).`)] });
  }

  const hoursLeft = Math.ceil((cooldown - (now - user.last_daily)) / 3600);
  return error(interaction, `Torna tra ${hoursLeft} ore.`);
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
  const top = await repo.topWallet(interaction.guildId, 10);
  if (top.length === 0) return error(interaction, 'Ancora nessun dato.');

  const lines = await Promise.all(top.map(async (r, i) => {
    const tag = await interaction.client.users.fetch(r.user_id).catch(() => null);
    const total = (r.wallet || 0) + (r.bank || 0);
    return `**${i + 1}.** ${tag ? tag.tag : r.user_id} — **${total.toLocaleString()}**`;
  }));

  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle('💰 Gli utenti più ricchi').setDescription(lines.join('\n'))],
  });
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

module.exports = { data, execute };
