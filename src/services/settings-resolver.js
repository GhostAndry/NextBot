'use strict';

// Risolve un tunable del bot per una specifica guild applicando, in ordine:
//   1. Override per-guild salvato in GuildConfig.settings (JSON blob)
//   2. Valore globale in config.json
//   3. Fallback esplicito passato dal chiamante
//
// I call-site restano leggibili:
//   const xpMin = await getSetting(interaction.guildId, 'xpMin', 15);

const repo = require('../db/repo');

async function getSetting(guildId, key, fallback) {
  const override = await repo.getGuildSetting(guildId, key, undefined);
  if (override !== undefined) return override;
  if (fallback !== undefined) return fallback;
  return null;
}

async function setSetting(guildId, key, value) {
  return repo.setGuildSetting(guildId, key, value);
}

async function resetSetting(guildId, key) {
  return repo.deleteGuildSetting(guildId, key);
}

// Lista di tutti i tunables che possono essere sovrascritti per-guild.
// Usato dal comando /settings per validare le chiavi accettate.
const KNOWN_SETTINGS = {
  // Levels
  xpMin: { label: 'XP minimo per messaggio', min: 1, max: 100, type: 'int' },
  xpMax: { label: 'XP massimo per messaggio', min: 1, max: 200, type: 'int' },
  cooldownSeconds: { label: 'Cooldown XP (secondi)', min: 0, max: 3600, type: 'int' },
  announceLevelUp: { label: 'Annuncia level-up', type: 'bool' },

  // Moderation
  maxWarns: { label: 'Warn massimi prima azione', min: 1, max: 20, type: 'int' },
  warnAction: { label: 'Azione al raggiungimento max warn', type: 'enum', values: ['mute', 'kick', 'ban', 'none'] },

  // Tickets
  ticketsEnabled: { label: 'Sistema ticket attivo', type: 'bool' },
  transcriptOnClose: { label: 'Trascrizione alla chiusura ticket', type: 'bool' },
  maxPerUser: { label: 'Ticket massimi per utente', min: 1, max: 50, type: 'int' },

  // Temp channels
  tempChannelsEnabled: { label: 'Canali temporanei attivi', type: 'bool' },
  autoDeleteSecondsEmpty: { label: 'Auto-elimina temp channel (s)', min: 5, max: 3600, type: 'int' },
  defaultUserLimit: { label: 'Limite utenti temp voice (0=illimitato)', min: 0, max: 99, type: 'int' },

  // Autorole / welcome
  autoroleEnabled: { label: 'Autorole al join attivo', type: 'bool' },
  welcomeEnabled: { label: 'Messaggio di benvenuto attivo', type: 'bool' },
};

function isKnownKey(key) {
  return Object.prototype.hasOwnProperty.call(KNOWN_SETTINGS, key);
}

function getKnownMeta(key) {
  return KNOWN_SETTINGS[key] || null;
}

function validateValue(meta, raw) {
  if (!meta) return { ok: false, error: 'Chiave non riconosciuta.' };

  if (meta.type === 'int') {
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n)) return { ok: false, error: 'Inserisci un numero intero.' };
    if (meta.min !== undefined && n < meta.min) return { ok: false, error: `Valore minimo: ${meta.min}.` };
    if (meta.max !== undefined && n > meta.max) return { ok: false, error: `Valore massimo: ${meta.max}.` };
    return { ok: true, value: n };
  }

  if (meta.type === 'bool') {
    const v = String(raw).trim().toLowerCase();
    if (['on', 'true', 'si', 'sì', '1', 'attivo', 'attiva'].includes(v)) return { ok: true, value: true };
    if (['off', 'false', 'no', '0', 'disattivo', 'disattiva'].includes(v)) return { ok: true, value: false };
    return { ok: false, error: 'Usa on/off (oppure true/false).' };
  }

  if (meta.type === 'enum') {
    const v = String(raw).trim().toLowerCase();
    if (!meta.values.includes(v)) return { ok: false, error: `Valori ammessi: ${meta.values.join(', ')}.` };
    return { ok: true, value: v };
  }

  return { ok: true, value: String(raw) };
}

function listKeys() {
  return Object.entries(KNOWN_SETTINGS).map(([key, meta]) => ({ key, ...meta }));
}

module.exports = {
  getSetting,
  setSetting,
  resetSetting,
  isKnownKey,
  getKnownMeta,
  validateValue,
  listKeys,
  KNOWN_SETTINGS,
};
