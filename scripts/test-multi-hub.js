'use strict';

const repo = require('../src/db/repo');
const voiceTracker = require('../src/services/voice-state-tracker');

(async () => {
  console.log('=== Test multi-hub ===\n');

  // Simula l'aggiunta di due hub in una guild di test.
  const guildId = 'test-guild-' + Date.now();
  const hub1 = 'hub-' + Date.now() + '-1';
  const hub2 = 'hub-' + Date.now() + '-2';

  // Cleanup di sicurezza nel caso il test precedente abbia lasciato righe.
  await repo.removeVoiceHub(hub1).catch(() => {});
  await repo.removeVoiceHub(hub2).catch(() => {});

  await repo.addVoiceHub(guildId, hub1, 'Hub Generale', 'parent-1');
  await repo.addVoiceHub(guildId, hub2, 'VIP Lounge', 'parent-2');

  const hubs = await repo.listVoiceHubs(guildId);
  console.log('Hub registrati:', hubs.length);
  for (const h of hubs) {
    console.log(`  - ${h.name} (channelId=${h.channel_id}, default=${h.is_default})`);
  }

  // Il primo aggiunto dovrebbe essere default.
  const defaultHub = hubs.find((h) => h.is_default);
  console.log('Default:', defaultHub?.name, defaultHub?.name === 'Hub Generale' ? 'OK' : 'FAIL');

  // Cambio il default al secondo.
  await repo.setDefaultVoiceHub(hub2);
  const hubs2 = await repo.listVoiceHubs(guildId);
  const defaultHub2 = hubs2.find((h) => h.is_default);
  console.log('Default dopo cambio:', defaultHub2?.name, defaultHub2?.name === 'VIP Lounge' ? 'OK' : 'FAIL');

  // Aggiungo un temp channel sotto il primo hub.
  const tempId = 'temp-' + Date.now();
  await repo.openTempChannel(tempId, guildId, 'user-aaa', 'voice', hub1);
  voiceTracker.set(guildId, tempId, 'user-aaa', hub1);

  const listHub1 = voiceTracker.listByHub(guildId, hub1);
  console.log('Temp sotto hub-1:', listHub1.length, listHub1.length === 1 ? 'OK' : 'FAIL');

  // Rinomino l'hub.
  await repo.renameVoiceHub(hub2, 'VIP Premium');
  const renamed = await repo.getVoiceHubByChannel(hub2);
  console.log('Hub rinominato:', renamed?.name, renamed?.name === 'VIP Premium' ? 'OK' : 'FAIL');

  // getHubChannelIds restituisce solo i channelId.
  const ids = await repo.getHubChannelIds(guildId);
  console.log('Channel IDs:', [...ids].sort());

  // Rimuovo un hub.
  await repo.removeVoiceHub(hub1);
  const remaining = await repo.listVoiceHubs(guildId);
  console.log('Hub rimasti:', remaining.length, remaining.length === 1 ? 'OK' : 'FAIL');

  // Pulizia.
  await repo.removeTempChannel(tempId).catch(() => {});
  await repo.removeVoiceHub(hub2);

  console.log('\nTutti i test passati.');
})().catch((err) => {
  console.error('Errore:', err);
  process.exit(1);
});
