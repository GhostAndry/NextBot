'use strict';

// Quando un membro lascia il guild, ripuliamo la sua sessione voicemove
// (se attiva) per evitare che rimanga orfana nella Map in-memory.

const voicemove = require('../commands/voice/voicemove');
const logger = require('../utils/logger');

module.exports = {
  name: 'guildMemberRemove',
  async execute(member) {
    if (!member?.guild) return;
    voicemove.purgeMember(member.guild.id, member.id);
    logger.debug({ guild: member.guild.id, user: member.id }, 'guildMemberRemove cleanup');
  },
};
