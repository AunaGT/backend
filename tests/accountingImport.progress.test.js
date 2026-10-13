const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

test('revierte cuentas si se desconecta antes del commit', async () => {
  const prismaPath = require.resolve('../src/models/prisma')
  const controllerPath = require.resolve('../src/modules/accounting/import.controller')
  const committed = []
  const res = new EventEmitter()
  res.setHeader = () => {}
  res.flushHeaders = () => {}
  res.write = () => {}
  res.end = () => {}
  const prisma = {
    account: { findMany: async () => [] },
    $transaction: async (work) => {
      const staged = []
      await work({ account: {
        findMany: async () => [],
        create: async ({ data }) => { staged.push(data); res.emit('close'); return { id: staged.length } },
      } })
      committed.push(...staged)
    },
  }
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { prisma } }
  delete require.cache[controllerPath]
  try {
    const ctrl = require(controllerPath)
    await ctrl.bulkImportAccountsStream({ body: { items: [
      { code: '100', name: 'Activo', type: 'Activo' },
      { code: '101', name: 'Caja', type: 'Activo' },
    ] }, companyId: 'co-a' }, res)
    assert.deepEqual(committed, [])
  } finally {
    delete require.cache[controllerPath]
    delete require.cache[prismaPath]
  }
})

test('marca asiento completo solo después del commit', async () => {
  const prismaPath = require.resolve('../src/models/prisma')
  const corePath = require.resolve('../src/services/accounting/core')
  const controllerPath = require.resolve('../src/modules/accounting/import.controller')
  const events = []
  let committed = false
  const res = new EventEmitter()
  res.setHeader = () => {}
  res.flushHeaders = () => {}
  res.write = chunk => events.push(JSON.parse(chunk.slice(6)))
  res.end = () => {}
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { prisma: {
    account: { findMany: async () => [{ id: 1, code: '100', active: true, is_group: false }, { id: 2, code: '200', active: true, is_group: false }] },
    accountingPeriod: { findMany: async () => [] },
    $transaction: async work => { await work({}); committed = true },
  } } }
  require.cache[corePath] = { id: corePath, filename: corePath, loaded: true, exports: {
    createEntry: async () => ({ entry_number: 'A-000001' }),
    periodKeyForDate: () => ({ year: 2026, month: 9 }),
    AccountingError: class AccountingError extends Error {},
  } }
  delete require.cache[controllerPath]
  try {
    const ctrl = require(controllerPath)
    await ctrl.bulkImportJournalStream({ companyId: 'co-a', user: { sub: 'user-a' }, body: { items: [
      { reference: 'R-1', date: '2026-09-01', accountCode: '100', debit: 10, credit: 0 },
      { reference: 'R-1', date: '2026-09-01', accountCode: '200', debit: 0, credit: 10 },
    ] } }, res)
    assert.equal(committed, true)
    assert.equal(events.at(-1).type, 'complete')
    assert.equal(events.at(-1).processed, 2)
  } finally {
    delete require.cache[controllerPath]
    delete require.cache[corePath]
    delete require.cache[prismaPath]
  }
})
