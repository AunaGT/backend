require('dotenv/config')
const { prisma, prismaTransaction } = require('../src/models/prisma')
const { prepareDeductions } = require('../src/services/payroll/prepareDeductions')
async function main() {
  const companies = await prisma.company.findMany({ select: { id: true, name: true } })
  for (const company of companies) {
    const result = await prismaTransaction.$transaction(tx => prepareDeductions(tx, company.id), { maxWait: 15000, timeout: 30000 })
    console.log(`${company.name}: ${result.configured ? 'cuenta de descuentos preparada' : result.conflict}`)
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 }).finally(async () => { await prisma.$disconnect(); if (prismaTransaction !== prisma) await prismaTransaction.$disconnect() })
