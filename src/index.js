'use strict';

// Bootstrap entry point.
//
// Three execution modes:
//   1. REDIS_ENABLED=true  + LEADER_ELECTION_ENABLED=true  -> hot-standby failover
//   2. REDIS_ENABLED=true  + LEADER_ELECTION_ENABLED=false -> bot runs but no lock taken
//   3. REDIS_ENABLED=false                                 -> single-node, no Redis at all
//
// In mode 1, two nodes share a Redis lock. The holder runs the bot, the other polls.
// On leader failure, the other takes the lock and starts the bot.

const config = require('./config');
const logger = require('./utils/logger');
const { LeaderElector } = require('./services/leader-elector');
const { startLeaderBot, stopBot } = require('./services/bot');

const elector = createElector();

let client = null;
let shuttingDown = false;

async function main() {
  logStartupBanner();

  if (shouldUseRedis()) {
    await elector.connect(config.redis);
  }

  if (config.leader.enabled && shouldUseRedis()) {
    await runHotStandbyLoop();
  } else {
    await runSingleNode();
  }
}

function createElector() {
  return new LeaderElector({
    nodeId: config.node.id,
    lockKey: config.leader.lockKey,
    lockTtlSeconds: config.leader.lockTtl,
    renewIntervalSeconds: config.leader.renewInterval,
  });
}

function shouldUseRedis() {
  return config.redis.enabled && config.leader.enabled;
}

function logStartupBanner() {
  logger.info(
    {
      node: config.node.id,
      db: config.db.driver,
      redis: config.redis.enabled,
      leader: config.leader.enabled,
    },
    'starting NextBot node',
  );
}

async function runSingleNode() {
  client = await startLeaderBot();
  elector.isLeader = true;
  await waitForShutdown();
}

async function runHotStandbyLoop() {
  const acquired = await elector.tryAcquire();
  if (acquired) {
    elector.isLeader = true;
    logger.info('bootstrapped as leader');
    try {
      client = await startLeaderBot();
      elector.startRenewLoop(() => {
        logger.info('lost leadership mid-flight');
        stopBot(client).then(() => { client = null; });
      });
    } catch (err) {
      logger.error({ err }, 'bootstrap as leader failed, releasing lock');
      elector.isLeader = false;
      await elector.releaseIfOwner();
    }
  } else {
    logger.info('lock held by another node, entering standby');
  }

  await pollForLeadership();
}

async function pollForLeadership() {
  while (!shuttingDown) {
    if (!elector.isLeader) {
      try {
        if (await elector.isLockFree()) {
          const acquired = await elector.tryAcquire();
          if (!acquired) {
            await sleep();
            continue;
          }
          elector.isLeader = true;
          logger.info('acquired leadership, starting bot');
          try {
            client = await startLeaderBot();
            elector.startRenewLoop(() => {
              logger.info('lost leadership mid-flight');
              stopBot(client).then(() => { client = null; });
            });
          } catch (err) {
            logger.error({ err }, 'start as new leader failed');
            elector.isLeader = false;
            await elector.releaseIfOwner();
          }
        }
      } catch (err) {
        logger.error({ err }, 'standby poll error');
      }
    }
    await sleep();
  }
}

function sleep() {
  return new Promise((resolve) => setTimeout(resolve, config.leader.standbyPoll * 1000));
}

async function waitForShutdown() {
  return new Promise((resolve) => {
    process.once('SIGINT', () => shutdown().then(resolve));
    process.once('SIGTERM', () => shutdown().then(resolve));
  });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down');

  elector.stopRenewLoop();
  await elector.releaseIfOwner();
  await stopBot(client);
  client = null;

  try {
    await require('./db').disconnectDatabase();
  } catch (_) {}

  if (shouldUseRedis()) {
    await elector.quit();
  }

  process.exit(0);
}

process.on('uncaughtException', (err) => logger.error({ err }, 'uncaughtException'));
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandledRejection'));

main().catch((err) => {
  logger.error({ err }, 'fatal boot error');
  process.exit(1);
});
