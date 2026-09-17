'use strict';

const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, getVoiceConnection } = require('@discordjs/voice');

// Per-guild player + connection. We keep only one active per guild because the
// soundboard is meant for short clips. The connection auto-cleans 30s after the
// player goes Idle so a guild channel isn't held hostage.

const idleDisconnectMs = 30_000;
const playerReadyTimeoutMs = 10_000;

const players = new Map();

async function ensureConnection(guildId, voiceChannel, guild) {
  let connection = getVoiceConnection(guildId);
  if (connection) return connection;

  connection = joinVoiceChannel({
    guildId,
    channelId: voiceChannel.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, playerReadyTimeoutMs);
  return connection;
}

function playerFor(guildId, connection) {
  let player = players.get(guildId);
  if (player) return player;
  player = createAudioPlayer();
  connection.subscribe(player);
  players.set(guildId, player);
  return player;
}

async function play(guild, voiceChannel, filePath, volume) {
  const connection = await ensureConnection(guild.id, voiceChannel, guild);
  const player = playerFor(guild.id, connection);

  const resource = createAudioResource(filePath, { inlineVolume: true });
  if (resource.volume && typeof volume === 'number') {
    resource.volume.setVolume(volume);
  }

  player.play(resource);
  scheduleAutoLeave(guild.id, player);
}

function scheduleAutoLeave(guildId, player) {
  player.once(AudioPlayerStatus.Idle, () => {
    setTimeout(() => {
      const conn = getVoiceConnection(guildId);
      if (conn && player.state.status === AudioPlayerStatus.Idle) {
        conn.destroy();
      }
      players.delete(guildId);
    }, idleDisconnectMs);
  });
}

function stop(guildId) {
  const player = players.get(guildId);
  const connection = getVoiceConnection(guildId);
  if (player) player.stop(true);
  if (connection) connection.destroy();
  players.delete(guildId);
}

module.exports = { play, stop };
