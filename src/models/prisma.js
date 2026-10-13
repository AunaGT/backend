/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

const { PrismaClient } = require('@prisma/client')

// Connection strategy:
// - Use pooled DATABASE_URL (PgBouncer port 6543) for normal API traffic for better scalability.
// - Use DIRECT_URL (5432) only for migrations / generate / seed where long transactions may be needed.
// Previously we overwrote DATABASE_URL with DIRECT_URL in dev which defeats pooling and may exhaust
// connection limits, and if DIRECT_URL is temporarily unreachable you'll see P1001 errors.
// We now keep DATABASE_URL intact. If it's missing we fall back to DIRECT_URL.

if (!process.env.DATABASE_URL && process.env.DIRECT_URL) {
  console.warn('[prisma] DATABASE_URL not set, falling back to DIRECT_URL (no pool).')
  process.env.DATABASE_URL = process.env.DIRECT_URL
}

if (process.env.DATABASE_URL) {
  console.log('[prisma] Using DATABASE_URL (pooled) host:', process.env.DATABASE_URL.split('@')[1]?.split(':')[0])
} else {
  console.error('[prisma] No DATABASE_URL or DIRECT_URL provided!')
}

const prisma = new PrismaClient({
  // Las fotos solo salen como URL firmada desde los DTO autorizados de contactos.
  omit: { supplier: { image_storage_path: true } },
  log: process.env.PRISMA_LOG_QUERIES === 'true' ? ['query', 'error', 'warn'] : ['error', 'warn']
})

// Create a separate Prisma client for transactions that uses DIRECT_URL
// This is needed because pooled connections (PgBouncer) don't support transactions
let prismaTransaction = null
if (process.env.DIRECT_URL) {
  prismaTransaction = new PrismaClient({
    omit: { supplier: { image_storage_path: true } },
    datasources: {
      db: {
        url: process.env.DIRECT_URL
      }
    },
    log: process.env.PRISMA_LOG_QUERIES === 'true' ? ['query', 'error', 'warn'] : ['error', 'warn']
  })
  console.log('[prisma] Transaction client initialized with DIRECT_URL')
} else {
  // Fallback to regular prisma if DIRECT_URL is not available
  prismaTransaction = prisma
  console.warn('[prisma] DIRECT_URL not set, transactions will use pooled connection (may fail)')
}

process.on('SIGINT', async () => {
  try { 
    await prisma.$disconnect()
    if (prismaTransaction !== prisma) {
      await prismaTransaction.$disconnect()
    }
  } catch (e) { /* ignore */ }
  process.exit(0)
})
process.on('SIGTERM', async () => {
  try { 
    await prisma.$disconnect()
    if (prismaTransaction !== prisma) {
      await prismaTransaction.$disconnect()
    }
  } catch (e) { /* ignore */ }
  process.exit(0)
})

module.exports = { prisma, prismaTransaction }
