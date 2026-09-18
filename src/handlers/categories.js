'use strict';

// Group commands by the sub-folder they live in. Read once at runtime.

const path = require('path');
const fs = require('fs');

const CATEGORIES = {
  moderation: { label: 'Moderazione', emoji: '🛡️' },
  tickets: { label: 'Ticket', emoji: '🎫' },
  levels: { label: 'Livelli', emoji: '📈' },
  economy: { label: 'Economia', emoji: '💰' },
  games: { label: 'Giochi', emoji: '🎲' },
  voice: { label: 'Voce', emoji: '🔊' },
  soundboard: { label: 'Soundboard', emoji: '🎵' },
  fun: { label: 'Divertimento', emoji: '🎉' },
  general: { label: 'Generale', emoji: '⚙️' },
};

function categoryFor(filepath) {
  const commandsDir = path.join(__dirname, '..', 'commands');
  const relative = path.relative(commandsDir, filepath);
  const top = relative.split(path.sep)[0];
  return CATEGORIES[top] ? top : 'general';
}

function listByCategory() {
  const commandsDir = path.join(__dirname, '..', 'commands');
  const grouped = {};

  function walk(dir) {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.js')) continue;
      const cmd = require(full);
      if (!cmd.data) continue;
      const cat = categoryFor(full);
      if (!grouped[cat]) grouped[cat] = [];

      // Estrai i subcommand dal JSON del builder, se presenti.
      let subs = [];
      try {
        const json = cmd.data.toJSON();
        if (Array.isArray(json.options)) {
          subs = json.options
            .filter((o) => o.type === 1 /* SUB_COMMAND */)
            .map((o) => ({ name: o.name, description: o.description || '' }));
        }
      } catch (_) {}

      grouped[cat].push({
        name: cmd.data.name,
        description: cmd.data.description || '',
        subs,
      });
    }
  }

  walk(commandsDir);
  return grouped;
}

module.exports = { CATEGORIES, listByCategory };
