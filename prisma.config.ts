import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaBetterSQLite3 } from '@prisma/adapter-better-sqlite3';
import * as path from 'node:path';

const driver = readDriver();

export default defineConfig({
  schema: schemaPathForDriver(driver),
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: buildDatasourceUrl(),
  },
});

function readDriver(): 'sqlite' | 'postgresql' {
  const raw = require('../config.json');
  const driver = raw.database?.driver || 'sqlite';
  if (driver !== 'sqlite' && driver !== 'postgresql') {
    throw new Error(`Unknown database.driver in config.json: ${driver}`);
  }
  return driver;
}

function schemaPathForDriver(driver: 'sqlite' | 'postgresql'): string {
  return driver === 'postgresql'
    ? path.join(__dirname, 'prisma', 'schema.postgres.prisma')
    : path.join(__dirname, 'prisma', 'schema.prisma');
}

function buildDatasourceUrl(): string {
  // Esportato per il CLI ma non usato direttamente: Prisma 7 lo legge
  // come stringa opaca e noi passiamo l'adapter via runtime.
  const driver = readDriver();
  if (driver === 'postgresql') {
    // Il CLI non userà mai veramente questo URL (richiede driver-adapter),
    // ma è richiesto dal config type. Viene sovrascritto a runtime.
    return 'postgresql://placeholder';
  }
  return 'file:./data/nextbot.db';
}
