'use strict';

// Prisma 7 setup helper: legge config.json, sceglie lo schema giusto
// (sqlite vs postgres), e rigenera il client + applica lo schema al DB.
// IMPORTANTE: in Prisma 7 il client generato è legato al provider dello
// schema. Se config.database.driver cambia, devi rilanciare questo script
// prima di `npm start`.

const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const driver = readDriver();
const schema = driver === 'postgres' ? 'prisma/schema.postgres.prisma' : 'prisma/schema.prisma';

run('npx', ['prisma', 'db', 'push', '--schema', schema]);
run('npx', ['prisma', 'generate', '--schema', schema]);

console.log(`✅ ${driver === 'postgres' ? 'Postgres' : 'SQLite'} schema applied and client generated.`);

function readDriver() {
  const raw = require(path.join(ROOT, 'config.json'));
  const driver = raw.database?.driver || 'sqlite';
  if (driver !== 'sqlite' && driver !== 'postgres') {
    throw new Error(`Unknown database.driver in config.json: ${driver}. Use "sqlite" or "postgres".`);
  }
  return driver;
}

function run(cmd, args) {
  execFileSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
  });
}
