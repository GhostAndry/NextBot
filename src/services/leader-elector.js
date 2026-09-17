'use strict';

const ioredis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');

// Atomic renewal: only extend TTL if the lock still belongs to us.
// Prevents a standby from accidentally renewing the leader's lock
// after a network blip where it briefly sees the same key.
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
else
  return 0
end
`;

class LeaderElector {
  constructor({ nodeId, lockKey, lockTtlSeconds, renewIntervalSeconds }) {
    this.nodeId = nodeId;
    this.lockKey = lockKey;
    this.lockTtl = lockTtlSeconds;
    this.renewIntervalMs = renewIntervalSeconds * 1000;
    this.client = null;
    this.renewTimer = null;
    this.isLeader = false;
  }

  async connect({ host, port, password }) {
    this.client = new ioredis({
      host,
      port,
      password,
      retryStrategy: (attempt) => Math.min(attempt * 100, 3000),
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
    });
    this.client.on('error', (err) => logger.error({ err }, 'redis error'));
    await this.client.ping();
    logger.info({ host, port }, 'redis connected');
  }

  async tryAcquire() {
    const result = await this.client.set(this.lockKey, this.nodeId, 'EX', this.lockTtl, 'NX');
    return result === 'OK';
  }

  async renew() {
    const res = await this.client.eval(RENEW_LUA, 1, this.lockKey, this.nodeId, this.lockTtl);
    return res === 1;
  }

  startRenewLoop(onLost) {
    this.stopRenewLoop();
    this.renewTimer = setInterval(async () => {
      try {
        const ok = await this.renew();
        if (!ok) {
          logger.warn('lock renewal failed - lost leadership');
          this.stopRenewLoop();
          this.isLeader = false;
          if (typeof onLost === 'function') onLost();
        }
      } catch (err) {
        logger.error({ err }, 'renew error');
      }
    }, this.renewIntervalMs);
  }

  stopRenewLoop() {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
  }

  async releaseIfOwner() {
    if (!this.isLeader) return;
    try {
      const owner = await this.client.get(this.lockKey);
      if (owner === this.nodeId) {
        await this.client.del(this.lockKey);
      }
    } catch (err) {
      logger.error({ err }, 'release error');
    }
  }

  async isLockFree() {
    const exists = await this.client.exists(this.lockKey);
    return exists === 0;
  }

  async quit() {
    try { await this.client.quit(); } catch (_) {}
  }
}

module.exports = { LeaderElector };
