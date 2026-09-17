'use strict';

const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const config = require('../config');

// Driver-adapter Prisma 7: ogni provider richiede il suo adapter esplicito,
// anche SQLite (che ora passa attraverso @prisma/adapter-better-sqlite3).
// Il client generato (`npm run db:setup` / `prisma generate`) è agnostico
// rispetto al runtime adapter: a cambiare è solo cosa passiamo al costruttore.

const prisma = new PrismaClient({ adapter: buildAdapter(config) });

module.exports = prisma;

function buildAdapter(cfg) {
  const driver = cfg.database?.driver || 'sqlite';

  if (driver === 'postgres') {
    const pg = cfg.database.postgres || {};
    return new PrismaPg({
      host: pg.host || '127.0.0.1',
      port: pg.port || 5432,
      user: pg.user || 'nextbot',
      password: pg.password || '',
      database: pg.database || 'nextbot',
    });
  }

  const sqlitePath = path.resolve(process.cwd(), cfg.database?.sqlite?.path || './data/nextbot.db');
  return new PrismaBetterSqlite3({ url: sqlitePath });
}
