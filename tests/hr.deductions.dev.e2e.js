require('../src/config/loadEnv')
const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { PrismaClient } = require('@prisma/client')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const { buildPayslip } = require('../src/services/payroll/build')
const { DEFAULT_RATES } = require('../src/services/payroll/rates')
const { ACCOUNTS_SEED, DEFAULT_ACCOUNT_CODES } = require('../src/services/accounting/seedChartOfAccounts')
const { prepareDeductions } = require('../src/services/payroll/prepareDeductions')
const TX = { timeout: 30000, maxWait: 15000 }
test('development Supabase: manual deductions, concurrent confirmations, accounting and rollback', { timeout: 240000 }, async () => {
  const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } } })
  const companyId = randomUUID(), branchId = randomUUID(), otherBranchId = randomUUID(), employeeId = randomUUID(), actorId = randomUUID()
  let roleId
  const permissions = ['hr.deductions.view', 'hr.deductions.manage', 'payroll.view', 'payroll.confirm', 'payroll.cancel'], scope = { companyId, branchId, user: { sub: actorId, auth_version: 0, permissions } }
  const invoke = async (fn, req) => { const res = { ...jsonResponse(), set() { return this } }; let error; await fn(req, res, e => { error = e }); if (error) throw error; return res.body }
  try {
    await db.company.create({ data: { id: companyId, code: `ded-${companyId.slice(0, 12)}`, name: 'QA descuentos temporal' } })
    await db.branch.createMany({ data: [{ id: branchId, company_id: companyId, name: 'QA descuentos', code: 'QA' }, { id: otherBranchId, company_id: companyId, name: 'Otra QA descuentos', code: 'QA2' }] })
    const grants = await db.permission.findMany({ where: { code: { in: permissions } } })
    const role = await db.role.create({ data: { company_id: companyId, name: 'QA descuentos gestor', permissions: { create: grants.map(p => ({ permission_id: p.id })) } } }); roleId = role.id
    await db.user.create({ data: { id: actorId, name: 'QA descuentos gestor', email: `${actorId}@example.invalid`, password: randomUUID(), role_id: role.id, user_companies: { create: { company_id: companyId, role_id: role.id } }, user_branches: { create: { branch_id: branchId } } } })
    await db.account.createMany({ data: ACCOUNTS_SEED.map(({ parent, ...account }) => ({ ...account, company_id: companyId })) })
    await db.systemSetting.create({ data: { company_id: companyId, key: 'accounting.defaultAccounts', type: 'json', value: JSON.stringify(DEFAULT_ACCOUNT_CODES) } })
    await db.$transaction(tx => prepareDeductions(tx, companyId), TX)
    await db.$transaction(tx => prepareDeductions(tx, companyId), TX)
    assert.equal(await db.account.count({ where: { company_id: companyId, code: '2108' } }), 1)
    const employee = await db.employee.create({ data: { id: employeeId, company_id: companyId, branch_id: branchId, code: 'QA', first_name: 'Ana', last_name: 'Descuento QA', hire_date: new Date('2020-01-01'), base_salary: '5000.00', bonificacion_incentivo: '250.00' } })
    await assert.rejects(db.employeeDeduction.create({ data: { company_id: companyId, branch_id: branchId, employee_id: employeeId, amount: '-1.00', reason: 'Invalido' } }))
    const mocks = { [require.resolve('../src/models/prisma')]: { prisma: db, prismaTransaction: db } }
    await withMocks(mocks, require.resolve('../src/modules/hr/controllers/deductions'), async hr => {
      const request = { ...scope, body: { employee_id: employeeId, amount: '125.50', reason: 'Acuerdo de descuento identificado', target_run_id: null }, params: {}, query: {} }
      await assert.rejects(invoke(hr.create, { ...request, user: { permissions: [] } }), e => e.status === 403)
      await assert.rejects(invoke(hr.create, { ...request, branchId: otherBranchId }), e => e.status === 404)
      await assert.rejects(invoke(hr.create, { ...request, companyId: randomUUID() }), e => e.status === 404)
      const deduction = await invoke(hr.create, request)
      assert.equal(String(deduction.amount), '125.5'); assert.equal(deduction.status, 'PENDIENTE')
      const updated = await invoke(hr.update, { ...request, params: { id: deduction.id }, body: { ...request.body, revision: 1, amount: '150.50' } })
      assert.equal(updated.revision, 2)
      await assert.rejects(invoke(hr.update, { ...request, params: { id: deduction.id }, body: { ...request.body, revision: 1 } }), e => e.status === 409)
      const makeRun = async code => {
        const run = await db.payrollRun.create({ data: { company_id: companyId, branch_id: branchId, code, name: code, type: 'ORDINARIA', period_start: new Date('2099-10-01'), period_end: new Date('2099-10-31'), pay_date: new Date('2099-10-31'), rates_snapshot: { rates: DEFAULT_RATES } } })
        const frozen = await db.employeeDeduction.findUnique({ where: { id: deduction.id } })
        const slip = buildPayslip({ employee, run, rates: DEFAULT_RATES, deductions: [frozen] })
        const { lines, ...totals } = slip
        await db.payslip.create({ data: { run_id: run.id, employee_id: employeeId, base_salary: employee.base_salary, ...totals, lines: { create: lines } } })
        await db.payrollRun.update({ where: { id: run.id }, data: { total_earnings: slip.total_earnings, total_deductions: slip.total_deductions, total_net: slip.net_pay, total_employer_cost: slip.employer_cost } })
        return run
      }
      const first = await makeRun('QA-D1'), second = await makeRun('QA-D2')
      await withMocks(mocks, require.resolve('../src/modules/payroll/controllers/transitions'), async transitions => {
        const req = run => ({ ...scope, params: { id: run.id } })
        const results = await Promise.allSettled([invoke(transitions.confirm, req(first)), invoke(transitions.confirm, req(second))])
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
        assert.equal(results.find(r => r.status === 'rejected').reason.status, 409)
        const winner = results.find(r => r.status === 'fulfilled').value
        const loser = winner.id === first.id ? second : first
        assert.equal((await db.payrollRun.findUnique({ where: { id: loser.id } })).status, 'BORRADOR')
        assert.equal(await db.employeeDeduction.count({ where: { company_id: companyId, status: 'APLICADO' } }), 1)
        const entries = await db.journalEntry.findMany({ where: { company_id: companyId }, include: { lines: true } })
        assert.equal(entries.length, 1)
        const cents = entries[0].lines.reduce((sum, l) => sum + Math.round(Number(l.debit) * 100) - Math.round(Number(l.credit) * 100), 0)
        assert.equal(cents, 0)
        const clearing = await db.account.findFirst({ where: { company_id: companyId, code: '2108' } })
        assert.equal(String(entries[0].lines.find(l => l.account_id === clearing.id).credit), '150.5')
        await assert.rejects(invoke(hr.update, { ...request, params: { id: deduction.id }, body: { ...request.body, revision: 3 } }), e => e.status === 409)
        await invoke(transitions.cancel, req(winner))
        const restored = await db.employeeDeduction.findUnique({ where: { id: deduction.id } })
        assert.equal(restored.status, 'PENDIENTE'); assert.equal(restored.applied_run_id, null)
        // A fresh run sees the restored revision. Missing account must roll back every claim.
        const rollbackRun = await makeRun('QA-ROLLBACK')
        await db.account.update({ where: { id: clearing.id }, data: { active: false } })
        await assert.rejects(invoke(transitions.confirm, req(rollbackRun)), e => e.status === 422)
        assert.equal((await db.employeeDeduction.findUnique({ where: { id: deduction.id } })).status, 'PENDIENTE')
        assert.equal((await db.payrollRun.findUnique({ where: { id: rollbackRun.id } })).status, 'BORRADOR')
        assert.equal(await db.journalEntry.count({ where: { company_id: companyId, source_id: rollbackRun.id } }), 0)
        await db.account.update({ where: { id: clearing.id }, data: { active: true } })
        // New deductions cannot disappear merely because the earlier run had no line for them.
        await invoke(hr.create, { ...request, body: { ...request.body, amount: '10.00', reason: 'Alta posterior al borrador' } })
        await assert.rejects(invoke(transitions.confirm, req(rollbackRun)), e => e.status === 409)
        const cancelled = await invoke(hr.cancel, { ...request, params: { id: deduction.id }, body: { revision: restored.revision, reason: 'Ensayo terminado' } })
        assert.equal(cancelled.status, 'CANCELADO')
        const directed = await invoke(hr.create, { ...request, body: { ...request.body, amount: '7.00', target_run_id: rollbackRun.id } })
        await withMocks(mocks, require.resolve('../src/modules/payroll/controllers/payroll'), async payroll => {
          await assert.rejects(invoke(payroll.remove, req(rollbackRun)), e => e.status === 409)
        })
        await invoke(transitions.cancel, req(rollbackRun))
        assert.equal((await db.employeeDeduction.findUnique({ where: { id: directed.id } })).target_run_id, rollbackRun.id)
        const reprogrammed = await invoke(hr.update, { ...request, params: { id: directed.id }, body: { ...request.body, revision: directed.revision, amount: '7.00', target_run_id: null } })
        assert.equal(reprogrammed.target_run_id, null)
      })
      const history = await db.employeeHistory.findMany({ where: { employee_id: employeeId } })
      assert.ok(history.some(h => h.event === 'DEDUCTION_APPLIED')); assert.ok(history.some(h => h.event === 'DEDUCTION_RESTORED'))
      assert.ok(history.some(h => h.event === 'DEDUCTION_UPDATED' && h.changes.before.amount === '125.5' && h.changes.after.amount === '150.5'))
      await withMocks(mocks, require.resolve('../src/modules/hr/controllers/employeeHistory'), async controller => {
        const response = await invoke(controller.list, { ...scope, user: { permissions: ['hr.employees.view'] }, params: { id: employeeId }, query: {} })
        assert.equal(response.totalItems, 0); assert.equal(response.items.length, 0)
        const allowed = await invoke(controller.list, { ...scope, params: { id: employeeId }, query: {} })
        assert.equal(allowed.totalItems, history.length)
      })
      // Moving the employee removes their private deductions from the old branch, including counts.
      await db.employee.update({ where: { id: employeeId }, data: { branch_id: otherBranchId } })
      for (const query of [{}, { employee_id: employeeId }]) {
        const hidden = await invoke(hr.list, { ...scope, query })
        assert.equal(hidden.totalItems, 0); assert.equal(hidden.items.length, 0)
      }
      await db.employee.update({ where: { id: employeeId }, data: { branch_id: branchId } })
      const manageGrant = grants.find(p => p.code === 'hr.deductions.manage')
      for (const revoke of ['permission', 'branch']) {
        let release, locked, queued
        const gate = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { locked = resolve }), blocked = new Promise(resolve => { queued = resolve })
        const holder = db.$transaction(async tx => { await tx.$queryRaw`SELECT id FROM employees WHERE id=${employeeId}::uuid FOR UPDATE`; locked(); await gate }, TX)
        await ready
        const observed = new Proxy(db, { get(target, property) {
          if (property !== '$transaction') return Reflect.get(target, property)
          return (callback, options) => db.$transaction(tx => callback(new Proxy(tx, { get(client, key) {
            if (key !== '$queryRaw') return Reflect.get(client, key)
            return (...args) => { if (args[0].join('').includes('FROM employees')) queued(); return client.$queryRaw(...args) }
          } })), options)
        } })
        try {
          await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db, prismaTransaction: observed } }, require.resolve('../src/modules/hr/controllers/deductions'), async queuedHr => {
            const before = await db.employeeDeduction.count({ where: { company_id: companyId } })
            const pending = invoke(queuedHr.create, request); pending.catch(() => {})
            await blocked
            if (revoke === 'permission') await db.rolePermission.delete({ where: { role_id_permission_id: { role_id: role.id, permission_id: manageGrant.id } } })
            else await db.userBranch.delete({ where: { user_id_branch_id: { user_id: actorId, branch_id: branchId } } })
            release(); await holder
            await assert.rejects(pending, e => e.status === 403)
            assert.equal(await db.employeeDeduction.count({ where: { company_id: companyId } }), before)
          })
        } finally {
          release(); await holder
          if (revoke === 'permission') await db.rolePermission.upsert({ where: { role_id_permission_id: { role_id: role.id, permission_id: manageGrant.id } }, create: { role_id: role.id, permission_id: manageGrant.id }, update: {} })
          else await db.userBranch.upsert({ where: { user_id_branch_id: { user_id: actorId, branch_id: branchId } }, create: { user_id: actorId, branch_id: branchId }, update: {} })
        }
      }
    })
  } catch (error) {
    console.error('Escenario de descuentos:', error.message)
    throw error
  } finally {
    // Exact UUID owned by this test; never delete records from another company.
    await db.payslip.deleteMany({ where: { run: { company_id: companyId } } })
    await db.employeeDeduction.deleteMany({ where: { company_id: companyId } })
    await db.payrollRun.deleteMany({ where: { company_id: companyId } })
    await db.journalEntry.deleteMany({ where: { company_id: companyId } })
    await db.employeeHistory.deleteMany({ where: { company_id: companyId } })
    await db.employee.deleteMany({ where: { company_id: companyId } })
    await db.account.deleteMany({ where: { company_id: companyId } })
    await db.systemSetting.deleteMany({ where: { company_id: companyId } })
    await db.settingAuditEvent.deleteMany({ where: { company_id: companyId } })
    await db.accountingPeriod.deleteMany({ where: { company_id: companyId } })
    await db.user.deleteMany({ where: { id: actorId } })
    if (roleId) { await db.rolePermission.deleteMany({ where: { role_id: roleId } }); await db.role.delete({ where: { id: roleId } }) }
    await db.branch.deleteMany({ where: { company_id: companyId } })
    await db.company.deleteMany({ where: { id: companyId } })
    await db.$disconnect()
  }
})
