'use strict';

const repo = require('../db/repo');
const voiceTracker = require('../services/voice-state-tracker');
const voiceStateEvent = require('./voiceStateUpdate');
const logger = require('../utils/logger');

module.exports = {
  name: 'channelDelete',
  async execute(channel) {
    if (!channel.guildId) return;

    const temp = await repo.getTempChannel(channel.id);
    if (temp) {
      await repo.removeTempChannel(channel.id);
      voiceTracker.remove(channel.guildId, channel.id);
      voiceStateEvent.clearPanelSent(channel.id);
      logger.info({ channel: channel.id }, 'record canale temporaneo ripulito');
    }

    const ticket = await repo.getTicketByChannel(channel.id);
    if (ticket && !ticket.closed) {
      await repo.closeTicket(channel.id);
    }
  },
};
