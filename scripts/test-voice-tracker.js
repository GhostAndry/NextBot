'use strict';

const voiceTracker = require('../src/services/voice-state-tracker');
const voiceStateEvent = require('../src/events/voiceStateUpdate');

console.log('=== Test del flusso 👑 ===\n');

// 1. Popola la cache come farebbe syncFromDatabase all'avvio.
voiceTracker.set('guild123', 'channel456', 'user_aaa');
voiceTracker.set('guild123', 'channel789', 'user_bbb');
console.log('Inseriti 2 canali in cache');

// 2. Verifica il lookup (simula quello che faranno i bottoni).
const owner1 = voiceTracker.getOwnerId('guild123', 'channel456');
console.log('Owner channel456:', owner1, owner1 === 'user_aaa' ? 'OK' : 'FAIL');

// 3. Simula un transfer: sostituisce l'owner.
voiceTracker.set('guild123', 'channel456', 'user_ccc');
const owner2 = voiceTracker.getOwnerId('guild123', 'channel456');
console.log('Owner dopo transfer:', owner2, owner2 === 'user_ccc' ? 'OK' : 'FAIL');

// 4. Verifica rimozione (es. canale eliminato).
voiceTracker.remove('guild123', 'channel789');
const owner3 = voiceTracker.getOwnerId('guild123', 'channel789');
console.log('Owner dopo remove:', owner3, owner3 === null ? 'OK' : 'FAIL');

// 5. Verifica format del nome.
const formatted = voiceStateEvent.OWNER_PREFIX + "mario's room";
console.log('Nome formattato:', formatted, formatted.includes(voiceStateEvent.OWNER_PREFIX) ? 'OK' : 'FAIL');

// 6. list() per guild.
const list = voiceTracker.list('guild123');
console.log('Canali rimanenti in guild123:', list.length, list.length === 1 ? 'OK' : 'FAIL');

console.log('\nTutti i test passati.');
