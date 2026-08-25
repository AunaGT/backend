#!/usr/bin/env node
/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * Aplica el catálogo de cuentas (incluidas las de nómina) a TODAS las empresas.
 * Idempotente: upsert de cuentas y merge del mapeo por defecto.
 *
 * Correr: node scripts/seed-payroll-accounts.js
 */

// El .env no se carga solo cuando esto corre con `node` (index.js sí lo hace).
require('dotenv/config')
const { prisma } = require('../src/models/prisma')
const { seedChartOfAccounts } = require('../src/services/accounting/seedChartOfAccounts')

async function main() {
  const companies = await prisma.company.findMany({ select: { id: true, name: true } })
  for (const company of companies) {
    await seedChartOfAccounts(prisma, company.id)
    console.log(`  Cuentas actualizadas: ${company.name}`)
  }
  console.log(`${companies.length} empresa(s) procesada(s)`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
