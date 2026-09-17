'use strict';

// Prisma client lifecycle. Prisma is async-only, so unlike the old SQLite/PG
// adapter there's no synchronous init. We simply expose the singleton client
// and a no-op init to keep the boot flow uniform.

const prisma = require('./prisma');

async function initDatabase() {
  await prisma.$connect();
  return prisma;
}

function getDb() {
  return prisma;
}

async function disconnectDatabase() {
  await prisma.$disconnect();
}

module.exports = { initDatabase, getDb, disconnectDatabase, prisma };
