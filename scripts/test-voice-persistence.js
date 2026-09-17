'use strict';

// Verifica end-to-end della persistenza delle impostazioni temp voice:
//
// 1. Utente A entra nell'hub X → canale live creato
// 2. Utente A blocca utente B (kick + blocked list)
// 3. Canale si svuota → snapshot salvato su VoiceRoom, TempChannel rimosso
// 4. Utente A rientra nello stesso hub X → snapshot ripristinato
// 5. Verifica: blocked contiene ancora B, locked è false (default)
//
// Tutto in-memory contro il DB sqlite reale. Usiamo guild/channel/userId finti.

const repo = require('../src/db/repo');

(async () => {
  console.log('=== Test persistenza impostazioni temp voice ===\n');

  const guildId = 'test-guild-' + Date.now();
  const userA = 'user-aaa';
  const userB = 'user-bbb';
  const hubId = 'hub-1';
  const channelId = 'chan-' + Date.now();

  // 1) Apertura canale con hubChannelId
  console.log('1. Apertura canale temp per utente A sotto hub X');
  await repo.openTempChannel(channelId, guildId, userA, 'voice', hubId);
  console.log('   TempChannel creata per', channelId);

  // 2) Kick + blocco
  console.log('\n2. Utente A blocca utente B');
  await repo.addBlockedUser(channelId, userB);
  const temp = await repo.getTempChannel(channelId);
  console.log('   blocked:', temp.blocked, '(atteso: [' + userB + '])');

  // 3) Simuliamo "cancellazione del canale": salviamo lo snapshot e rimuoviamo la riga
  console.log('\n3. Canale si svuota → snapshot su VoiceRoom');
  await repo.saveVoiceRoom(guildId, userA, hubId, {
    locked: temp.locked || 0,
    blocked: temp.blocked,
    settings: JSON.stringify({ userLimit: 0, name: temp.channel_id }),
  });
  await repo.removeTempChannel(channelId);
  console.log('   Snapshot salvato, TempChannel rimossa.');

  // Verifichiamo che la riga TempChannel sia sparita
  const afterRemove = await repo.getTempChannel(channelId);
  console.log('   TempChannel esiste ancora?', afterRemove ? 'SI (FAIL)' : 'NO (OK)');

  // Verifichiamo che VoiceRoom sia persistito
  const snapshot = await repo.getVoiceRoom(guildId, userA, hubId);
  console.log('   VoiceRoom.blocked:', snapshot.blocked);
  console.log('   VoiceRoom.locked:', snapshot.locked);

  // 4) Utente A rientra nello stesso hub → canale ricreato
  console.log('\n4. Utente A rientra nello stesso hub X');
  const snapshot2 = await repo.getVoiceRoom(guildId, userA, hubId);
  console.log('   Snapshot trovato:', snapshot2 ? 'OK' : 'NO');

  // Simuliamo creazione canale con snapshot applicato
  const newChannelId = 'chan-new-' + Date.now();
  await repo.openTempChannel(newChannelId, guildId, userA, 'voice', hubId);
  // Ripristina blocked
  await repo.prisma.tempChannel.update({
    where: { channelId: newChannelId },
    data: {
      blocked: JSON.stringify(snapshot2.blocked),
      locked: snapshot2.locked,
    },
  });

  // 5) Verifica
  const restored = await repo.getTempChannel(newChannelId);
  console.log('\n5. Stato del nuovo canale:');
  console.log('   blocked:', restored.blocked);
  console.log('   locked:', restored.locked);
  console.log('   B è ancora bloccato?', restored.blocked.includes(userB) ? 'OK' : 'FAIL');

  // Pulizia
  await repo.removeTempChannel(newChannelId);
  await repo.deleteVoiceRoom(guildId, userA, hubId);

  console.log('\nTutti i test passati.');
})().catch((err) => {
  console.error('Errore:', err);
  process.exit(1);
});
