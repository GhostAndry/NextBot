'use strict';

const logger = require('../utils/logger');

module.exports = {
  name: 'ready',
  once: true,
  async execute(client) {
    logger.info({ user: client.user.tag, guilds: client.guilds.cache.size }, 'ready');
    client.user.setActivity({ name: '/help', type: 3 });
  },
};
