'use strict';

const logger = require('../utils/logger');

// discord.js v14 emette `ready` come prima, ma segnala DeprecationWarning.
// Registriamo entrambi gli handler per coprire v14 e v15: il secondo
// (clientReady) diventerà l'unico in v15. Quando il client arriva, `ready`
// potrebbe già aver fatto il setActivity; idem potenziale — `setActivity`
// è idempotente.
module.exports = {
  name: 'ready',
  once: true,
  async execute(client) {
    logger.info({ user: client.user.tag, guilds: client.guilds.cache.size }, 'ready');
    client.user.setActivity({ name: '/help', type: 3 });
  },
};

// Alias per silenziare il DeprecationWarning in v15+
module.exports.clientReady = {
  name: 'clientReady',
  once: true,
  async execute(client) {
    if (!client.user) return; // può scattare prima del login completo
    client.user.setActivity({ name: '/help', type: 3 });
  },
};
