'use strict';

// Pull + Prisma setup (db push + generate) + container restart sul server.
//
// Prerequisiti lato client (la macchina da cui lanci il deploy):
//   - `ssh srv-01` funzionante senza password (chiave in ~/.ssh/id_ed25519_srv-01
//     oppure un Host in ~/.ssh/config).
//   - sul server: container `nextbot-app` con bind mount
//     /home/andrea/NextBot -> /app.
//
// Uso:
//   node scripts/deploy.js                 # default: ssh srv-01
//   node scripts/deploy.js root@server     # host custom
//
// Se vuoi cambiare path del repo o nome del container, edita DEFAULTS qui sotto.

const { execFileSync } = require('child_process');

const DEFAULT_SSH_TARGET = process.argv[2] || 'srv-01';
const REPO_DIR = '/home/andrea/NextBot';
const CONTAINER = 'nextbot-app';

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function ssh(target, remoteCmd) {
  const args = ['-o', 'BatchMode=yes'];
  const useConfigAlias = !target.includes('@') && !target.includes(':');
  if (!useConfigAlias) {
    args.push(target);
  } else {
    args.push(target);
  }
  args.push(remoteCmd);
  run('ssh', args);
}

function main() {
  ssh(DEFAULT_SSH_TARGET,
    `set -e
     cd ${REPO_DIR}
     echo '== git pull =='
     git pull --rebase --autostash
     echo '== prisma db push =='
     docker exec ${CONTAINER} sh -c 'npx prisma db push'
     echo '== prisma generate =='
     docker exec ${CONTAINER} sh -c 'npx prisma generate'
     echo '== restart container =='
     docker restart ${CONTAINER}`
  );

  console.log('\n✅ deploy completato.');
}

main();
