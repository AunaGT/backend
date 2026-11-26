const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { qaSchema, fixture } = require('./helpers/cashSettlementsQa.cjs')
const url = process.env.AUNA_CASH_SETTLEMENT_QA_URL
const rejects = (promise, pattern) => assert.rejects(promise, e => pattern.test(String(e.message)) || pattern.test(String(e.code)), String(pattern))

test('bank method versions are proposed by a manager, approved only by the admin and frozen on each event', { skip: !url, timeout: 240000 }, async t => {
  const qa = await qaSchema(url, { migrate: false }), { db } = qa
  try {
    const projection = () => db.$queryRaw`SELECT 'event' AS kind,to_jsonb(e) AS row FROM cash_money_events e UNION ALL SELECT 'payment',to_jsonb(p) FROM customer_payments p
      UNION ALL SELECT 'entry',to_jsonb(j) FROM journal_entries j UNION ALL SELECT 'method',to_jsonb(m) FROM payment_methods m ORDER BY kind,row`
    const legacy = await fixture(db)
    const pay = (f, methodId, amount = 100) => db.$transaction(tx => require('../src/modules/receivables').applyPayment(tx, { ...f.scope, customerId: f.customer.id, amount, paymentMethodId: methodId, cashRegisterSessionId: f.period.id, allowAdvance: true }))
    const old = await pay(legacy, legacy.card.id)
    const before = await projection(); qa.apply(); assert.deepEqual(await projection(), before)
    const api = require('../src/modules/cash-closure/bankMethods')
    const run = fn => db.$transaction(fn, { timeout: 20000 })
    const manager = f => ({ ...f.scope, isAdmin: false, canManage: true }), admin = f => ({ ...f.scope, isAdmin: true, canManage: true })
    const modes = async eventSource => db.$queryRaw`SELECT m.mode,m.account_id FROM cash_bank_event_modes m JOIN cash_money_events e ON e.id=m.event_id WHERE e.source_id=${eventSource}::uuid`
    const propose = (f, extra = {}) => run(tx => api.proposeBankMethod(tx, manager(f), { paymentMethodId: f.card.id, mode: 'DEFERRED', destinationLabel: 'Visanet · BI 0012', bankAccountId: f.accounts.bank.id, clearingAccountId: f.accounts.clearing.id, feeAccountId: f.accounts.fee.id, ...extra }))

    await t.test('events before approval stay historical and a proposal classifies nothing', async () => {
      assert.deepEqual(await modes(old.paymentId), [])
      const f = await fixture(db), { version } = await propose(f)
      assert.equal(version.status, 'PROPOSED')
      assert.deepEqual(await modes((await pay(f, f.card.id)).paymentId), [])
      await assert.rejects(propose(f), e => e.status === 409, 'one open proposal per method')
    })

    await t.test('only the admin approves, and then new events freeze mode and account', async () => {
      const f = await fixture(db), { version } = await propose(f)
      const eligible = await api.bankMethodAccounts(db, manager(f))
      assert.deepEqual(eligible.assets.map(a => a.code), ['1102', '1105']); assert.deepEqual(eligible.expenses.map(a => a.code), ['6105'], 'income accounts are never offered')
      await assert.rejects(run(tx => api.approveBankMethod(tx, manager(f), version.id)), e => e.status === 403)
      await run(tx => api.approveBankMethod(tx, admin(f), version.id))
      assert.deepEqual(await modes((await pay(f, f.card.id)).paymentId), [{ mode: 'DEFERRED', account_id: f.accounts.clearing.id }])
      assert.deepEqual(await modes((await pay(f, f.bank.id)).paymentId), [], 'an unconfigured method is untouched')
    })

    await t.test('a change to an active method needs approval and never reclassifies frozen events', async () => {
      const f = await fixture(db), first = (await propose(f)).version
      await run(tx => api.approveBankMethod(tx, admin(f), first.id))
      const before = await pay(f, f.card.id)
      const change = (await propose(f, { mode: 'DIRECT', clearingAccountId: null, feeAccountId: null })).version
      assert.deepEqual(await modes((await pay(f, f.card.id)).paymentId), [{ mode: 'DEFERRED', account_id: f.accounts.clearing.id }], 'still the approved version')
      const stale = (await run(tx => api.listBankMethods(tx, admin(f)))).find(m => m.payment_method_id === f.card.id)
      assert.equal(stale.proposal.id, change.id); assert.equal(stale.active.mode, 'DEFERRED')
      await run(tx => api.approveBankMethod(tx, admin(f), change.id))
      assert.deepEqual(await modes(before.paymentId), [{ mode: 'DEFERRED', account_id: f.accounts.clearing.id }])
      assert.deepEqual(await modes((await pay(f, f.card.id)).paymentId), [{ mode: 'DIRECT', account_id: f.accounts.bank.id }])
    })

    await t.test('a proposal built on an outdated version cannot be approved', async () => {
      const f = await fixture(db), a = (await propose(f)).version
      await run(tx => api.approveBankMethod(tx, admin(f), a.id))
      const b = (await propose(f, { destinationLabel: 'Visanet nuevo' })).version
      await db.$executeRaw`UPDATE cash_bank_method_versions SET status='WITHDRAWN' WHERE id=${b.id}::uuid`
      const c = (await propose(f, { destinationLabel: 'Otro' })).version
      await run(tx => api.approveBankMethod(tx, admin(f), c.id))
      await rejects(db.$executeRaw`UPDATE cash_bank_method_versions SET status='APPROVED',decided_by_id=${f.user.id}::uuid WHERE id=${b.id}::uuid`, /cash_bank_method_state|cash_bank_method_stale/)
    })

    await t.test('accounts must be active, of the company and of the right type; frozen modes are immutable', async () => {
      const f = await fixture(db), other = await fixture(db)
      await assert.rejects(propose(f, { clearingAccountId: other.accounts.clearing.id }), e => e.status === 409 || e.status === 400)
      await assert.rejects(propose(f, { feeAccountId: f.accounts.income.id }), e => e.status === 409 || e.status === 400)
      await assert.rejects(propose(f, { paymentMethodId: f.method.id }), e => e.status === 409 || e.status === 400, 'cash is never a bank method')
      const v = (await propose(f)).version
      await run(tx => api.approveBankMethod(tx, admin(f), v.id))
      const p = await pay(f, f.card.id)
      await rejects(db.$executeRaw`UPDATE cash_bank_event_modes SET mode='DIRECT' WHERE event_id=(SELECT id FROM cash_money_events WHERE source_id=${p.paymentId}::uuid)`, /cash_bank_event_mode/)
      await rejects(db.$executeRaw`DELETE FROM cash_bank_event_modes WHERE event_id=(SELECT id FROM cash_money_events WHERE source_id=${p.paymentId}::uuid)`, /cash_bank_event_mode/)
    })
  } finally { await db.$disconnect() }
})

test('collections post to the frozen account: deferred to clearing, historical to bank', { skip: !url, timeout: 240000 }, async () => {
  const qa = await qaSchema(url), { db } = qa
  try {
    const f = await fixture(db), api = require('../src/modules/cash-closure/bankMethods')
    await db.companyModule.create({ data: { company_id: f.company.id, module_code: 'accounting', status: 'ACTIVE' } })
    const { DEFAULT_ACCOUNT_KEYS } = require('../src/services/accounting/core')
    const types = { receivables: 'ASSET', inventory: 'ASSET', ivaCredit: 'ASSET', cash: 'ASSET', payables: 'LIABILITY', ivaDebit: 'LIABILITY', pequenoTax: 'LIABILITY', sales: 'INCOME', salesReturns: 'INCOME', cogs: 'COST', pequenoTaxExpense: 'EXPENSE', currentEarnings: 'EQUITY', retainedEarnings: 'EQUITY' }
    const map = { bank: '1102' }
    for (const [i, key] of DEFAULT_ACCOUNT_KEYS.entries()) if (key !== 'bank') { map[key] = String(9000 + i); await db.account.create({ data: { company_id: f.company.id, code: map[key], name: key, type: types[key] || 'ASSET' } }) }
    await db.systemSetting.create({ data: { company_id: f.company.id, key: 'accounting.defaultAccounts', value: JSON.stringify(map) } })
    const pay = () => db.$transaction(tx => require('../src/modules/receivables').applyPayment(tx, { ...f.scope, customerId: f.customer.id, amount: 100, paymentMethodId: f.card.id, cashRegisterSessionId: f.period.id, allowAdvance: true }))
    const historical = await pay()
    const { version } = await db.$transaction(tx => api.proposeBankMethod(tx, { ...f.scope, canManage: true }, { paymentMethodId: f.card.id, mode: 'DEFERRED', destinationLabel: 'Visanet', bankAccountId: f.accounts.bank.id, clearingAccountId: f.accounts.clearing.id, feeAccountId: f.accounts.fee.id }))
    await db.$transaction(tx => api.approveBankMethod(tx, { ...f.scope, isAdmin: true }, version.id))
    const deferred = await pay()
    await require('../src/services/accounting/postingEngine').postPendingOperations(db, f.user.id, f.company.id)
    const debit = async id => (await db.$queryRaw`SELECT a.code FROM journal_entries j JOIN journal_lines l ON l.entry_id=j.id JOIN accounts a ON a.id=l.account_id
      WHERE j.company_id=${f.company.id}::uuid AND j.source_id=${id}::text AND l.debit>0`).map(r => r.code)
    assert.deepEqual(await debit(historical.paymentId), ['1102'], 'historical stays in bank')
    assert.deepEqual(await debit(deferred.paymentId), ['1105'], 'deferred goes to the clearing account')
    await require('../src/services/accounting/postingEngine').postPendingOperations(db, f.user.id, f.company.id)
    assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM journal_entries WHERE source_id=${deferred.paymentId}::text`)[0].n, 1, 'retrying does not post twice')
  } finally { await db.$disconnect() }
})

test('settlements tie deferred receipts to a real deposit, balance exactly and void cleanly', { skip: !url, timeout: 300000 }, async t => {
  const qa = await qaSchema(url), { db } = qa
  try {
    const methods = require('../src/modules/cash-closure/bankMethods'), api = require('../src/modules/cash-closure/settlements')
    const run = fn => db.$transaction(fn, { timeout: 20000 })
    const { DEFAULT_ACCOUNT_KEYS } = require('../src/services/accounting/core')
    async function prepare({ accounting = true } = {}) {
      const f = await fixture(db)
      if (!accounting) await db.companyModule.create({ data: { company_id: f.company.id, module_code: 'accounting', status: 'DISABLED' } })
      if (accounting) {
        await db.companyModule.create({ data: { company_id: f.company.id, module_code: 'accounting', status: 'ACTIVE' } })
        const map = { bank: '1102' }
        for (const [i, key] of DEFAULT_ACCOUNT_KEYS.entries()) if (key !== 'bank') { map[key] = String(9000 + i); await db.account.create({ data: { company_id: f.company.id, code: map[key], name: key, type: 'ASSET' } }) }
        await db.systemSetting.create({ data: { company_id: f.company.id, key: 'accounting.defaultAccounts', value: JSON.stringify(map) } })
      }
      const { version } = await run(tx => methods.proposeBankMethod(tx, { ...f.scope, canManage: true }, { paymentMethodId: f.card.id, mode: 'DEFERRED', destinationLabel: 'Visanet', bankAccountId: f.accounts.bank.id, clearingAccountId: f.accounts.clearing.id, feeAccountId: f.accounts.fee.id }))
      await run(tx => methods.approveBankMethod(tx, { ...f.scope, isAdmin: true }, version.id))
      f.staff = { ...f.scope, canSettle: true }
      f.charge = async (amount = 100, methodId = f.card.id) => { const { paymentId } = await run(tx => require('../src/modules/receivables').applyPayment(tx, { ...f.scope, customerId: f.customer.id, amount, paymentMethodId: methodId, cashRegisterSessionId: f.period.id, allowAdvance: true }))
        return (await db.$queryRaw`SELECT id FROM cash_money_events WHERE source_id=${paymentId}::uuid`)[0].id }
      f.settle = (extra = {}) => run(tx => api.createSettlement(tx, extra.scope || f.staff, { requestKey: randomUUID(), paymentMethodId: f.card.id, deposit: { reference: 'VN-' + randomUUID().slice(0, 8), depositedOn: '2026-11-01', totalAmount: extra.net ?? '96.50' }, net: '96.50', allocations: [], deductions: [], ...extra }))
      return f
    }
    const lines = async entryId => (await db.$queryRaw`SELECT a.code,l.debit::text AS debit,l.credit::text AS credit FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.entry_id=${entryId}::uuid ORDER BY a.code,l.debit`)
    const remaining = async (f, eventId) => (await api.pendingReceipts(db, f.staff, { paymentMethodId: f.card.id })).items.find(i => i.event_id === eventId)?.remaining ?? '0.00'

    await t.test('a card charge of 100 with a 3.50 fee settles 96.50 and the entry balances', async () => {
      const f = await prepare(), ev = await f.charge()
      const { settlement } = await f.settle({ allocations: [{ eventId: ev, amount: '100.00' }], deductions: [{ kind: 'FEE', amount: '3.50', description: 'Comisión Visanet' }] })
      assert.equal(settlement.net, '96.50'); assert.equal(settlement.status, 'POSTED')
      assert.deepEqual(await lines(settlement.journal_entry_id), [{ code: '1102', debit: '96.50', credit: '0.00' }, { code: '1105', debit: '0.00', credit: '100.00' }, { code: '6105', debit: '3.50', credit: '0.00' }])
      assert.equal(await remaining(f, ev), '0.00')
    })

    await t.test('a partial allocation leaves the rest pending and a historical or direct charge is not settleable', async () => {
      const f = await prepare(), ev = await f.charge()
      await f.settle({ allocations: [{ eventId: ev, amount: '60.00' }], net: '60.00', deposit: { reference: 'P-1', depositedOn: '2026-11-01', totalAmount: '60.00' } })
      assert.equal(await remaining(f, ev), '40.00')
      const direct = await f.charge(50, f.bank.id)
      await assert.rejects(f.settle({ allocations: [{ eventId: direct, amount: '50.00' }], net: '50.00', deposit: { reference: 'P-2', depositedOn: '2026-11-01', totalAmount: '50.00' } }), e => e.status === 409 || e.status === 404)
      await assert.rejects(f.settle({ allocations: [{ eventId: ev, amount: '40.01' }], net: '40.01', deposit: { reference: 'P-3', depositedOn: '2026-11-01', totalAmount: '40.01' } }), e => e.status === 409)
    })

    await t.test('a net that does not balance is refused without effects', async () => {
      const f = await prepare(), ev = await f.charge()
      await assert.rejects(f.settle({ allocations: [{ eventId: ev, amount: '100.00' }], net: '97.00', deductions: [{ kind: 'FEE', amount: '3.50', description: 'Comisión' }] }), e => e.status === 400 && e.code === 'CASH_SETTLEMENT_BALANCE')
      assert.equal(await remaining(f, ev), '100.00')
    })

    await t.test('two concurrent settlements of the same charge produce one', async () => {
      const f = await prepare(), ev = await f.charge()
      const body = n => ({ allocations: [{ eventId: ev, amount: '100.00' }], net: '100.00', deposit: { reference: 'C-' + n, depositedOn: '2026-11-01', totalAmount: '100.00' } })
      const results = await Promise.allSettled([f.settle(body(1)), f.settle(body(2))])
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.status, 409)
    })

    await t.test('voiding reverses the entry once and frees the balance; a later chargeback leaves earlier settlements intact', async () => {
      const f = await prepare(), ev = await f.charge(), other = await f.charge(80)
      const { settlement } = await f.settle({ allocations: [{ eventId: ev, amount: '100.00' }], net: '100.00', deposit: { reference: 'V-1', depositedOn: '2026-11-01', totalAmount: '100.00' } })
      const voided = await run(tx => api.voidSettlement(tx, f.staff, settlement.id, { reason: 'Referencia equivocada' }))
      assert.equal(voided.settlement.status, 'VOIDED'); assert.ok(voided.settlement.void_entry_id)
      assert.deepEqual(await lines(voided.settlement.void_entry_id), [{ code: '1102', debit: '0.00', credit: '100.00' }, { code: '1105', debit: '100.00', credit: '0.00' }])
      assert.equal((await run(tx => api.voidSettlement(tx, f.staff, settlement.id, { reason: 'Referencia equivocada' }))).replayed, true)
      assert.equal(await remaining(f, ev), '100.00')
      const first = (await f.settle({ allocations: [{ eventId: ev, amount: '100.00' }], net: '100.00', deposit: { reference: 'V-2', depositedOn: '2026-11-01', totalAmount: '100.00' } })).settlement
      const later = (await f.settle({ allocations: [{ eventId: other, amount: '80.00' }], net: '30.00', deposit: { reference: 'V-3', depositedOn: '2026-11-02', totalAmount: '30.00' },
        deductions: [{ kind: 'CHARGEBACK', amount: '50.00', accountId: f.accounts.fee.id, description: 'Contracargo del cobro anterior', eventId: ev }] })).settlement
      assert.equal(later.deductions[0].kind, 'CHARGEBACK')
      assert.equal((await api.getSettlement(db, f.staff, first.id)).status, 'POSTED', 'the earlier settlement is untouched')
    })

    await t.test('one deposit of 1,000 is distributed 600 + 400 across two branches and never over its total', async () => {
      const f = await prepare(), ev = await f.charge(600)
      const branchB = await db.branch.create({ data: { company_id: f.company.id, name: 'Sucursal B', code: 'B' } })
      const scopeB = { ...f.staff, branchId: branchB.id }
      const vb = { id: randomUUID() }
      await db.$executeRaw`INSERT INTO cash_registers(id,branch_id,name,code,kind,operation_mode,currency_code,updated_at) VALUES(${vb.id}::uuid,${branchB.id}::uuid,'Web B','WB','VIRTUAL','INDIVIDUAL','GTQ',now())`
      const adoption = require('../src/services/cashEventAdoption')
      const periodB = await run(async tx => { const [r] = await tx.$queryRaw`SELECT revision FROM cash_registers WHERE id=${vb.id}::uuid`; await adoption.adoptRegister(tx, { ...f.admin, branchId: branchB.id }, vb.id, { eventVersion: 1, expectedRevision: r.revision }, { adoptionEnabled: true })
        return adoption.openEventSession(tx, { ...f.scope, branchId: branchB.id }, await require('../src/services/cashSessionBoundary').lockScopedRegister(tx, { ...f.scope, branchId: branchB.id }, vb.id), { openingFloat: '0.00', notes: null }) })
      const { paymentId } = await run(tx => require('../src/modules/receivables').applyPayment(tx, { ...f.scope, branchId: branchB.id, customerId: f.customer.id, amount: 400, paymentMethodId: f.card.id, cashRegisterSessionId: periodB.id, allowAdvance: true }))
      const evB = (await db.$queryRaw`SELECT id FROM cash_money_events WHERE source_id=${paymentId}::uuid`)[0].id
      const deposit = { reference: 'DEP-1000', depositedOn: '2026-11-01', totalAmount: '1000.00' }
      const a = (await f.settle({ deposit, net: '600.00', allocations: [{ eventId: ev, amount: '600.00' }] })).settlement
      assert.equal((await api.getDeposit(db, f.staff, a.deposit_id)).pending, '400.00')
      await assert.rejects(f.settle({ scope: scopeB, deposit: { ...deposit, totalAmount: '999.00' }, net: '400.00', allocations: [{ eventId: evB, amount: '400.00' }] }), e => e.status === 409, 'same reference with another total')
      await f.settle({ scope: scopeB, deposit, net: '400.00', allocations: [{ eventId: evB, amount: '400.00' }] })
      assert.equal((await api.getDeposit(db, f.staff, a.deposit_id)).pending, '0.00')
      const extra = await f.charge(1)
      await assert.rejects(f.settle({ deposit, net: '1.00', allocations: [{ eventId: extra, amount: '1.00' }] }), e => e.status === 409 && e.code === 'CASH_SETTLEMENT_DEPOSIT_TOTAL')
      await run(tx => api.voidSettlement(tx, f.staff, a.id, { reason: 'Corrección' }))
      assert.equal((await api.getDeposit(db, f.staff, a.deposit_id)).pending, '600.00')
    })

    await t.test('without accounting the settlement is stored without an entry', async () => {
      const f = await prepare({ accounting: false }), ev = await f.charge()
      const { settlement } = await f.settle({ allocations: [{ eventId: ev, amount: '100.00' }], deductions: [{ kind: 'FEE', amount: '3.50', description: 'Comisión' }] })
      assert.equal(settlement.journal_entry_id, null); assert.equal(settlement.status, 'POSTED')
    })
  } finally { await db.$disconnect() }
})
