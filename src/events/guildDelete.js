'use strict';

// Quando il bot lascia un guild, tutti i canali temp e le sessioni di voicemove
// di quel guild devono essere rilasciate per evitare memory leak. Stessa cosa
// quando un utente lascia il guild: la sua sessione voicemove è orfana.

const voicemove = require('../commands/voice/voicemove');
const voiceTracker = require('../services/voice-state-tracker');
const logger = require('../utils/logger');

module.exports = {
  name: 'guildDelete',
  async execute(guild) {
    voicemove.purgeGuild(guild.id);
    voiceTracker.purgeGuild?.(guild.id);
    logger.info({ guild: guild.id }, 'cleanup guild rimosso');
  },
};
