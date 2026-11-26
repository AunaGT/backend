const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { qaSchema, fixture } = require('./helpers/cashRegisterAccessQa.cjs')
const qaUrl = process.env.AUNA_CASH_ACCESS_QA_URL
test('explicit register configuration preserves legacy and owns isolated command/access records', { skip: !qaUrl, timeout: 90000 }, async t => {
  const qa = await qaSchema(qaUrl, { migrate: false }), { db } = qa
  try {
    const old = await fixture(db)
    const api = require('../src/modules/sales/cashRegisters.configuration')
    assert.equal(await api.registerConfigurationAvailable(db), false)
    await assert.rejects(api.loadRegisterConfiguration(db, old.scope, old.register.id), e => e.code === 'CASH_CONFIGURATION_UNAVAILABLE')
    await db.user.update({ where: { id: old.user.id }, data: { cash_register_id: old.register.id } })
    await old.receipt(db)
    const permission = await db.permission.create({ data: { code: 'legacy.cash.qa', name: 'Permiso anterior QA' } })
    await db.rolePermission.create({ data: { role_id: old.user.role_id, permission_id: permission.id } })
    for (const roleId of [112,139]) {
      await db.role.create({ data: { id: roleId, name: 'Vendedor QA '+roleId, company_id: old.company.id } })
      await db.rolePermission.create({ data: { role_id: roleId, permission_id: permission.id } })
    }
    const closure = await db.cashClosure.create({ data: { branch_id: old.branch.id, start_date: new Date('2026-10-28T08:00:00Z'), end_date: new Date('2026-10-28T18:00:00Z'), cashier_name: 'Anterior QA', cashier_id: old.user.id, opening_float: 200, theoretical_total: 250, theoretical_sales: 0, theoretical_returns: 0, actual_total: 250, difference: 0, total_transactions: 0, total_customers: 0, average_ticket: 0 } })
    await db.cashClosurePayment.create({ data: { cash_closure_id: closure.id, payment_method_id: old.method.id, theoretical_amount: 250, theoretical_count: 1, actual_amount: 250, difference: 0 } })
    await db.cashClosureDenomination.create({ data: { cash_closure_id: closure.id, type: 'Billete', denomination: 50, quantity: 5, subtotal: 250 } })
    const projection = () => db.$queryRaw`SELECT 'register' AS kind,to_jsonb(r)-'access_control_version' AS row FROM cash_registers r
      UNION ALL SELECT 'user',to_jsonb(u) FROM users u UNION ALL SELECT 'session',to_jsonb(s) FROM cash_register_sessions s
      UNION ALL SELECT 'receipt',to_jsonb(p) FROM customer_payments p UNION ALL SELECT 'closure',to_jsonb(c) FROM cash_closures c
      UNION ALL SELECT 'breakdown',to_jsonb(p) FROM cash_closure_payments p UNION ALL SELECT 'denomination',to_jsonb(d) FROM cash_closure_denominations d
      UNION ALL SELECT 'event',to_jsonb(e) FROM cash_money_events e UNION ALL SELECT 'role',to_jsonb(r) FROM roles r
      UNION ALL SELECT 'permission',to_jsonb(p) FROM permissions p UNION ALL SELECT 'grant',to_jsonb(g) FROM role_permissions g
      UNION ALL SELECT 'membership',to_jsonb(m) FROM user_companies m UNION ALL SELECT 'branch_assignment',to_jsonb(a) FROM user_branches a ORDER BY kind,row`
    const before = await projection()
    qa.apply()
    assert.deepEqual(await projection(), before)
    assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM cash_register_access`)[0].n, 0)
    assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM cash_register_commands`)[0].n, 0)
    assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM cash_registers WHERE access_control_version<>0`)[0].n, 0)
    const save = (f, body) => db.$transaction(tx => api.saveRegisterConfiguration(tx, f.scope, body), { timeout: 20000 })
    await t.test('create retries preserve a single register, command and unchanged global preference', async () => {
      const command = { requestKey: randomUUID(), name: 'Caja nueva', code: 'NUEVA', currencyCode: 'GTQ', authorizedUserIds: [old.user.id] }
      const [a, b] = await Promise.all([save(old, command), save(old, command)])
      assert.equal(a.id, b.id); assert.equal([a, b].filter(r => r.replayed).length, 1)
      assert.equal(await db.cashRegister.count({ where: { branch_id: old.branch.id, code: 'NUEVA' } }), 1)
      assert.equal((await db.user.findUnique({ where: { id: old.user.id } })).cash_register_id, old.register.id)
      assert.equal(a.authorized_users[0].id, old.user.id); assert.equal(a.access_control_version, 0)
      assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM cash_register_commands WHERE register_id=${a.id}::uuid`)[0].n, 1)
      await assert.rejects(save(old, { ...command, name: 'Otro contenido' }), e => e.status === 409)
      await assert.rejects(db.$executeRaw`UPDATE cash_register_commands SET request_hash=${'b'.repeat(64)} WHERE register_id=${a.id}::uuid`, /cash_register_command_immutable/)
    })
    await t.test('concurrent revisions have one winner and replay preserves the saved revision', async () => {
      const f = await fixture(db)
      const input = { id: f.register.id, expectedRevision: 2, requestKey: randomUUID(), name: 'Primera' }
      const commands = [input, { ...input, requestKey: randomUUID(), name: 'Segunda' }]
      const results = await Promise.allSettled(commands.map(command => save(f, command)))
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
      assert.equal(results.find(r => r.status === 'rejected').reason.status, 409)
      const current = await api.loadRegisterConfiguration(db, f.scope, f.register.id)
      assert.equal(current.revision, 3)
      const won = commands[results.findIndex(r => r.status === 'fulfilled')]
      await save(f, { id: f.register.id, expectedRevision: current.revision, requestKey: randomUUID(), name: 'Posterior' })
      const replay = await save(f, won)
      assert.equal(replay.replayed, true); assert.equal(replay.revision, 3)
      assert.equal((await api.loadRegisterConfiguration(db, f.scope, f.register.id)).name, 'Posterior')
    })
    await t.test('foreign branch ids and foreign/inactive users cannot gain access or expose results', async () => {
      const f = await fixture(db), other = await fixture(db)
      await assert.rejects(api.loadRegisterConfiguration(db, other.scope, f.register.id), e => e.status === 404)
      for (const userId of [other.user.id, randomUUID()]) await assert.rejects(save(f, { id: f.register.id, expectedRevision: 2, requestKey: randomUUID(), name: 'Caja', authorizedUserIds: [userId] }), e => e.status === 400)
      await db.userCompany.update({ where: { user_id_company_id: { user_id: f.user.id, company_id: f.company.id } }, data: { status: 'INACTIVE' } })
      await assert.rejects(save(f, { id: f.register.id, expectedRevision: 2, requestKey: randomUUID(), name: 'Caja', authorizedUserIds: [f.user.id] }), e => e.status === 400)
      assert.equal((await db.cashRegister.findUnique({ where: { id: f.register.id } })).name, 'QA')
    })
    await t.test('currency/history and pending work cannot be rewritten or hidden', async () => {
      const f = await fixture(db)
      const input = { id: f.register.id, expectedRevision: 2, requestKey: randomUUID(), name: 'Caja' }
      await assert.rejects(save(f, { ...input, currencyCode: 'USD' }), e => e.status === 409 || e.status === 400)
      await assert.rejects(save(f, { ...input, active: false }), e => e.status === 409)
      await db.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      await assert.rejects(save(f, { ...input, active: false }), e => e.status === 409)
    })
    await t.test('explicit access requires an adopted individual box and cannot revoke its operating owner', async () => {
      const f = await fixture(db, 1)
      const input = { id: f.register.id, expectedRevision: 2, requestKey: randomUUID(), name: 'Caja', authorizedUserIds: [f.user.id], enableExplicitAccess: true }
      await assert.rejects(save(f, input), e => e.status === 409)
      await db.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      await assert.rejects(save(f, { ...input, active: false }), e => e.status === 409)
      const enabled = await save(f, input); assert.equal(enabled.access_control_version, 1)
      await assert.rejects(db.$executeRaw`UPDATE cash_registers SET access_control_version=0 WHERE id=${f.register.id}::uuid`, /cash_register_access/)
      const turn = await db.$transaction(async tx => require('../src/services/cashEventAdoption').openEventSession(tx, f.scope,
        await require('../src/services/cashSessionBoundary').lockScopedRegister(tx, f.scope, f.register.id), { openingFloat: '0.00', notes: null }))
      const current = await api.loadRegisterConfiguration(db, f.scope, f.register.id)
      await assert.rejects(save(f, { ...input, requestKey: randomUUID(), expectedRevision: current.revision, authorizedUserIds: [], enableExplicitAccess: undefined }), e => e.code === 'CASH_REGISTER_OWNER_ACTIVE')
      assert.ok(turn.id)
    })
    await t.test('access history cannot be deleted or moved across scoped identities', async () => {
      const f = await fixture(db), other = await fixture(db)
      await save(f, { id: f.register.id, expectedRevision: 2, requestKey: randomUUID(), name: 'Caja', authorizedUserIds: [f.user.id] })
      await assert.rejects(db.$executeRaw`UPDATE cash_register_access SET company_id=${other.company.id}::uuid WHERE register_id=${f.register.id}::uuid`, /cash_register_access_identity_immutable/)
      await assert.rejects(db.$executeRaw`DELETE FROM cash_register_access WHERE register_id=${f.register.id}::uuid`, /cash_register_access_history/)
    })
    await t.test('enabling explicit access cannot simultaneously deactivate an otherwise eligible box', async () => {
      const f = await fixture(db)
      const r = await db.cashRegister.create({ data: { branch_id: f.branch.id, name: 'Libre', code: 'LIBRE' } })
      await db.$executeRaw`UPDATE cash_registers SET currency_code='GTQ',money_event_version=1 WHERE id=${r.id}::uuid`
      await assert.rejects(save(f, { id: r.id, expectedRevision: 1, requestKey: randomUUID(), name: 'Libre', active: false, authorizedUserIds: [f.user.id], enableExplicitAccess: true }), e => e.code === 'CASH_REGISTER_ACCESS_REQUIREMENTS')
    })
    await t.test('explicit authorization is current, scoped and does not allow operating someone else’s turn', async () => {
      const f = await fixture(db, 1), boundary = require('../src/services/cashSessionBoundary')
      await db.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      await save(f, { id: f.register.id, expectedRevision: 2, requestKey: randomUUID(), name: 'Caja', authorizedUserIds: [f.user.id], enableExplicitAccess: true })
      const other = await db.user.create({ data: { name: 'Otro', email: randomUUID()+'@example.invalid', password: 'qa', role_id: f.user.role_id } })
      await db.userCompany.create({ data: { user_id: other.id, company_id: f.company.id, role_id: f.user.role_id } }); await db.userBranch.create({ data: { user_id: other.id, branch_id: f.branch.id } })
      await assert.rejects(db.$transaction(tx => boundary.lockScopedRegister(tx, { ...f.scope, userId: other.id }, f.register.id)), e => e.code === 'CASH_REGISTER_ACCESS_DENIED')
      await db.$transaction(tx => boundary.lockScopedRegister(tx, f.scope, f.register.id))
      const opened = await db.$transaction(async tx => require('../src/services/cashEventAdoption').openEventSession(tx, f.scope, await boundary.lockScopedRegister(tx, f.scope, f.register.id), { openingFloat: '0.00', notes: null }))
      const reg = await api.loadRegisterConfiguration(db, f.scope, f.register.id)
      await save(f, { id: f.register.id, expectedRevision: reg.revision, requestKey: randomUUID(), name: 'Caja', authorizedUserIds: [f.user.id, other.id] })
      await assert.rejects(db.$transaction(async tx => boundary.assertSessionOperation(await boundary.lockScopedSession(tx, f.scope, opened.id), { ...f.scope, userId: other.id })), e => e.code === 'CASH_SESSION_OTHER_USER')
      await db.userCompany.update({ where: { user_id_company_id: { user_id: f.user.id, company_id: f.company.id } }, data: { status: 'INACTIVE' } })
      await assert.rejects(db.$transaction(tx => boundary.lockScopedRegister(tx, f.scope, f.register.id)), e => e.code === 'CASH_REGISTER_ACCESS_DENIED')
      await assert.rejects(db.$transaction(async tx => boundary.assertSessionOperation(await boundary.lockScopedSession(tx, f.scope, opened.id), f.scope)), e => e.code === 'CASH_REGISTER_ACCESS_DENIED')
      const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
      await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db } }, require.resolve('../src/modules/sales/cashSessions.controller'), async cash => {
        const response = jsonResponse()
        await cash.closeSession({ companyId: f.company.id, branchId: f.branch.id, user: { sub: other.id, role: { name: 'Encargado', company_id: f.company.id }, permissions: ['cashclosure.create'] }, body: { cash_register_id: f.register.id }, query: {} }, response, e => { throw e })
        assert.equal(response.statusCode, 200); assert.equal(response.body.status, 'CLOSED')
      })
    })
    await t.test('legacy metadata is scoped, revisioned, cannot hide pending work or steal another branch preference', async () => {
      const f = await fixture(db), b = await db.branch.create({ data: { company_id: f.company.id, name: 'Otra', code: 'OTHER' } })
      await assert.rejects(db.$transaction(tx => api.legacyRegisterCommand(tx, { ...f.scope, branchId: b.id }, 'update', f.register.id, { name: 'Ajena' })), e => e.status === 404)
      await db.$transaction(tx => api.legacyRegisterCommand(tx, f.scope, 'update', f.register.id, { name: 'Renombrada' }))
      assert.equal((await api.loadRegisterConfiguration(db, f.scope, f.register.id)).revision, 3)
      await assert.rejects(db.$transaction(tx => api.legacyRegisterCommand(tx, f.scope, 'update', f.register.id, { active: false })), e => e.code === 'CASH_REGISTER_PENDING_WORK')
      const foreign = await db.cashRegister.create({ data: { branch_id: b.id, name: 'Ajena', code: 'FOREIGN' } })
      await db.user.update({ where: { id: f.user.id }, data: { cash_register_id: foreign.id } })
      await assert.rejects(db.$transaction(tx => api.legacyRegisterCommand(tx, f.scope, 'users', f.register.id, { user_ids: [f.user.id] })), e => e.code === 'CASH_PREFERENCE_OTHER_BRANCH')
    })
    await t.test('targeted permission registration preserves old grants, including sellers112/139', async () => {
      const admin = await db.role.create({ data: { name: 'admin', system_key: 'ADMIN', company_id: null } })
      const before = await db.rolePermission.findMany({ where: { role_id: { not: admin.id } }, orderBy: [{ role_id: 'asc' }, { permission_id: 'asc' }] })
      const { registerCashPermissionsForAdmin } = require('../scripts/register-cash-permissions')
      await registerCashPermissionsForAdmin(db); await registerCashPermissionsForAdmin(db)
      assert.deepEqual(await db.rolePermission.findMany({ where: { role_id: { not: admin.id } }, orderBy: [{ role_id: 'asc' }, { permission_id: 'asc' }] }), before)
      const grants = await db.rolePermission.findMany({ where: { role_id: admin.id }, include: { permission: true } })
      assert.deepEqual(grants.map(g => g.permission.code).sort(), ['cash.registers.manage','cash.registers.view'])
    })
    await t.test('defaults stay active and unique when two boxes are selected concurrently', async () => {
      const f = await fixture(db), boxes = []
      for (const code of ['A','B']) boxes.push(await db.cashRegister.create({ data: { name: code, code, branch_id: f.branch.id } }))
      await Promise.all(boxes.map(r => save(f, { id: r.id, expectedRevision: 1, requestKey: randomUUID(), name: r.name, isDefault: true })))
      const current = await db.$queryRaw`SELECT id,active,is_default,revision FROM cash_registers WHERE branch_id=${f.branch.id}::uuid`
      assert.equal(current.filter(r => r.is_default).length, 1); assert.equal(current.find(r => r.is_default).active, true)
      assert.deepEqual(current.filter(r => boxes.some(b => b.id === r.id)).map(r => r.revision).sort(), [2,3])
    })
    await t.test('archiving and opening serialize so an inactive box cannot acquire a new open turn', async () => {
      const f = await fixture(db), r = await db.cashRegister.create({ data: { name: 'Libre', code: 'LIBRE', branch_id: f.branch.id } })
      const outcomes = await Promise.allSettled([
        db.$transaction(tx => api.legacyRegisterCommand(tx, f.scope, 'update', r.id, { active: false })),
        db.$transaction(async tx => {
          await require('../src/services/cashSessionBoundary').lockScopedRegister(tx, f.scope, r.id)
          return tx.cashRegisterSession.create({ data: { cash_register_id: r.id, opened_by_id: f.user.id, opening_float: 0 } })
        }),
      ])
      assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1)
      const [row] = await db.$queryRaw`SELECT r.active,count(s.id)::int AS open FROM cash_registers r LEFT JOIN cash_register_sessions s ON s.cash_register_id=r.id AND s.status='OPEN' WHERE r.id=${r.id}::uuid GROUP BY r.id`
      assert.ok(row.active || row.open === 0)
    })
    await t.test('invalid access adoption, duplicate codes and cross-scope foreign keys leave no partial configuration', async () => {
      const f = await fixture(db), other = await fixture(db)
      const r = await db.cashRegister.create({ data: { name: 'Sin adoptar', code: 'LIBRE', branch_id: f.branch.id } })
      const input = { id: r.id, expectedRevision: 1, requestKey: randomUUID(), name: 'Sin adoptar', authorizedUserIds: [f.user.id], enableExplicitAccess: true }
      await assert.rejects(save(f, input), e => e.code === 'CASH_REGISTER_ACCESS_REQUIREMENTS')
      assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM cash_register_access WHERE register_id=${r.id}::uuid`)[0].n, 0)
      await assert.rejects(save(f, { name: 'Duplicada', code: 'LIBRE', requestKey: randomUUID() }), e => e.code === 'CASH_REGISTER_CODE_DUPLICATE')
      await assert.rejects(db.$executeRaw`INSERT INTO cash_register_access(company_id,branch_id,register_id,user_id,created_by,active) VALUES(${other.company.id}::uuid,${f.branch.id}::uuid,${r.id}::uuid,${f.user.id}::uuid,${f.user.id}::uuid,false)`, e => e.code === 'P2010' && e.meta?.code === '23503')
      const command = { name: 'Propia', code: 'PROPIA', requestKey: randomUUID() }, created = await save(f, command)
      const foreign = await save(other, command)
      assert.notEqual(created.id, foreign.id); assert.equal(foreign.replayed, false)
    })
    await t.test('membership removal serializes against opening and assignment, then rejects stale authority', async () => {
      const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
      const observe = promise => { promise.catch(() => {}); return promise }
      for (const operation of ['open','assign']) {
        const f = await fixture(db, 1), held = deferred(), release = deferred(), attempted = deferred()
        await db.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
        await save(f, { id: f.register.id, expectedRevision: 2, requestKey: randomUUID(), name: 'Caja', authorizedUserIds: [f.user.id], enableExplicitAccess: true })
        const removal = observe(db.$transaction(async tx => {
          const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`
          await tx.userCompany.update({ where: { user_id_company_id: { user_id: f.user.id, company_id: f.company.id } }, data: { status: 'INACTIVE' } })
          held.resolve(pid); await release.promise
        }, { timeout: 20000 }))
        const holderPid = await held.promise
        const competing = observe(db.$transaction(async tx => {
          const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`; attempted.resolve(pid)
          if (operation === 'open') {
            const boundary = require('../src/services/cashSessionBoundary')
            return require('../src/services/cashEventAdoption').openEventSession(tx, f.scope, await boundary.lockScopedRegister(tx, f.scope, f.register.id), { openingFloat: '0.00', notes: null })
          }
          return api.saveRegisterConfiguration(tx, f.scope, { id: f.register.id, expectedRevision: 3, requestKey: randomUUID(), name: 'Caja', authorizedUserIds: [f.user.id] })
        }, { timeout: 20000 }))
        const waitingPid = await attempted.promise
        try {
          const deadline = Date.now()+5000; let blocked = false
          while (Date.now() < deadline) { const [row] = await db.$queryRaw`SELECT ${holderPid}::int=ANY(pg_blocking_pids(${waitingPid}::int)) AS blocked`; if (row.blocked) { blocked = true; break } await new Promise(setImmediate) }
          assert.equal(blocked, true, 'PostgreSQL must prove the membership lock contention')
        } finally { release.resolve() }
        await removal
        await assert.rejects(competing, e => e.code === (operation === 'open' ? 'CASH_REGISTER_ACCESS_DENIED' : 'CASH_REGISTER_USER_MEMBERSHIP'))
        assert.equal(await db.cashRegisterSession.count({ where: { cash_register_id: f.register.id, status: 'OPEN' } }), 0)
      }
    })
    await t.test('eligible people are scoped minimal paginated data, not the users directory', async () => {
      const f = await fixture(db)
      const rows = await api.listEligibleRegisterUsers(db, f.scope, { page: 1, pageSize: 20, search: 'Cashier' })
      assert.equal(rows.items.length, 1); assert.deepEqual(Object.keys(rows.items[0]).sort(), ['id', 'name'])
      assert.equal(rows.totalItems, 1)
    })
  } finally { await db.$disconnect() }
})
