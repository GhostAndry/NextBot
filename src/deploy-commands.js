'use strict';

// CLI entry for command management.
//
// Usage:
//   npm run deploy                            clean stale + redeploy (safe default)
//   npm run deploy -- --dry-run               show diff, change nothing
//   npm run deploy -- --wipe                  wipe everything, then redeploy
//   npm run deploy -- --only-clean            delete stale commands, no redeploy
//   npm run deploy -- --remove a b c          delete specific commands by name
//   npm run deploy -- --unregister-all        unregister ALL guild commands on EVERY guild
//   npm run deploy -- --unregister-all --include-global   also wipe global commands
//   npm run deploy -- --list                  show where every command is registered

const logger = require('./utils/logger');
const {
  loadAllCommands,
  deployCommands,
  cleanStaleCommands,
  removeCommandsByName,
  wipeAllGuildCommands,
  listRegisteredCommands,
} = require('./handlers/registry');

const args = process.argv.slice(2);

function readRemoveList() {
  const idx = args.indexOf('--remove');
  if (idx === -1) return [];
  return args.slice(idx + 1).filter((a) => !a.startsWith('--'));
}

async function main() {
  loadAllCommands();

  const removeList = readRemoveList();

  if (args.includes('--list')) {
    const report = await listRegisteredCommands();
    logger.info({ report }, 'registered commands report');
    return;
  }

  if (args.includes('--unregister-all')) {
    const { guilds, removed } = await wipeAllGuildCommands({
      includeGlobal: args.includes('--include-global'),
    });
    logger.info({ guilds, removed }, 'unregistered all guild commands');
    return;
  }

  if (removeList.length) {
    const { removed } = await removeCommandsByName(removeList);
    logger.info({ removed }, 'removed commands by name');
    return;
  }

  if (args.includes('--only-clean')) {
    const { removed } = await cleanStaleCommands();
    logger.info({ removed }, 'cleaned stale commands');
    return;
  }

  const result = await deployCommands({
    wipe: args.includes('--wipe'),
    dryRun: args.includes('--dry-run'),
  });

  if (args.includes('--dry-run')) {
    logger.info(result, 'dry-run: no changes made');
  } else {
    logger.info('slash commands deployed');
  }
}

main().catch((err) => {
  logger.error({ err }, 'deploy failed');
  process.exit(1);
});
