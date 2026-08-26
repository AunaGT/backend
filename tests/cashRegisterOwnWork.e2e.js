/**
 * Reporte de QA: un usuario sin caja asignada ni caja default en la sucursal
 * usó una caja ad hoc (ni default ni asignada) para vender y cerrar turno.
 * Al volver a /cierre-caja, GET /cash-sessions/current devolvía 503 "No hay
 * caja configurada" aunque el turno cerrado y pendiente de arqueo seguía ahí.
 * resolveRegister() solo miraba caja asignada o caja default de sucursal, sin
 * considerar dónde el usuario tenía trabajo real (turno abierto o cerrado sin
 * arqueo). Ver src/controllers/cashSessions.controller.js resolveRegister().
 *
 * Uso: contra un Postgres desechable ya migrado.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const assert = (cond, msg) => {
  if (!cond) { console.error('FALLO:', msg); process.exitCode = 1; throw new Error(msg) }
  console.log('  ok:', msg)
}

const callController = (fn, req) => new Promise((resolve, reject) => {
  let status = 200
  const res = { status(code) { status = code; return res }, json(body) { resolve({ status, body }) } }
  Promise.resolve(fn(req, res, (e) => reject(e))).catch(reject)
})

async function main() {
  const role = await prisma.role.upsert({ where: { name: 'Admin' }, update: {}, create: { name: 'Admin' } })

  const cashSessions = require('../src/controllers/cashSessions.controller')

  const co = await prisma.company.create({ data: { name: 'Caja SA', code: `CJ${Date.now() % 100000}` } })
  const suc = await prisma.branch.create({ data: { company_id: co.id, name: 'Zona 10', code: 'Z10', is_default: true } })
  // Ninguna caja marcada is_default en esta sucursal — a propósito, como en el reporte.
  const cajaAdHoc = await prisma.cashRegister.create({
    data: { branch_id: suc.id, name: 'Caja QA Promociones', code: 'CAJA-QA-PROMO', is_default: false },
  })
  const user = await prisma.user.create({
    // cash_register_id null a propósito: usuario sin caja asignada.
    data: { name: 'Fernando', email: `f${Date.now()}@x.com`, password: 'h', role_id: role.id, default_branch_id: suc.id },
  })

  const req = (query = {}, body = {}) => ({
    query, body, companyId: co.id, branchId: suc.id,
    user: { sub: user.id, role: { name: 'Admin' } },
    get: () => undefined,
  })

  console.log('\n== Sin turno: getCurrent no encuentra nada que resolver (esperado) ==')
  const antes = await callController(cashSessions.getCurrent, req())
  assert(antes.status === 503, `sin ninguna sesión propia, sigue sin caja que resolver (${antes.status})`)

  console.log('\n== Abrir y cerrar turno en la caja ad hoc, explícita (como en el POS) ==')
  const abierto = await callController(cashSessions.openSession, req({}, { opening_float: 100, cash_register_id: cajaAdHoc.id }))
  assert(abierto.status === 201, `abre turno (${abierto.status}) ${JSON.stringify(abierto.body).slice(0, 200)}`)

  const cerrado = await callController(cashSessions.closeSession, req({}, { cash_register_id: cajaAdHoc.id }))
  assert(cerrado.status === 200, `cierra turno (${cerrado.status}) ${JSON.stringify(cerrado.body).slice(0, 200)}`)

  console.log('\n== Volver a /cierre-caja sin especificar caja: debe encontrar el turno pendiente de arqueo ==')
  const despues = await callController(cashSessions.getCurrent, req())
  assert(despues.status === 200, `ya no da 503 (${despues.status}) ${JSON.stringify(despues.body).slice(0, 300)}`)
  assert(despues.body.register?.id === cajaAdHoc.id, 'resuelve la caja ad hoc, no una default inexistente')
  assert(despues.body.closable_session?.id === cerrado.body.id, 'y trae el turno recién cerrado como pendiente de arqueo')

  console.log('\nTODO OK')
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
