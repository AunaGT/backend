/**
 * Un usuario sin sucursales, o sin empresa, no puede volverse invisible: si no
 * sale en la lista no hay forma de arreglarlo desde la aplicación.
 * Uso: contra un Postgres desechable ya migrado y sembrado.
 */
const assert = require('assert')
const { prisma } = require('../src/models/prisma')
const usuarios = require('../src/modules/users/controller')

const call = (fn, req) => new Promise((resolve, reject) => {
  let status = 200
  const res = { status(c) { status = c; return res }, json(b) { resolve({ status, body: b }) } }
  Promise.resolve(fn(req, res, reject)).catch(reject)
})

async function main() {
  const co = await prisma.company.findFirst()
  const otra = await prisma.company.create({ data: { name: 'Ajena SA', code: `AJ${Date.now() % 100000}` } })
  const suc = await prisma.branch.findFirst({ where: { company_id: co.id } })
  const rol = await prisma.role.findFirst()
  const mk = async (name) => prisma.user.create({
    data: { name, email: `${name}${Date.now()}@x.com`, password: 'h', role_id: rol.id },
  })

  const conTodo = await mk('ConTodo')
  await prisma.userCompany.create({ data: { user_id: conTodo.id, company_id: co.id } })
  await prisma.userBranch.create({ data: { user_id: conTodo.id, branch_id: suc.id } })

  const sinSucursal = await mk('SinSucursal')
  await prisma.userCompany.create({ data: { user_id: sinSucursal.id, company_id: co.id } })

  const huerfano = await mk('Huerfano')

  const ajeno = await mk('Ajeno')
  await prisma.userCompany.create({ data: { user_id: ajeno.id, company_id: otra.id } })

  const req = { companyId: co.id, branchId: suc.id, query: { pageSize: 100 }, user: { sub: conTodo.id } }
  const lista = await call(usuarios.list, req)
  const ids = lista.body.items.map((u) => u.id)

  assert.ok(ids.includes(conTodo.id), 'el usuario completo sale en la lista')
  assert.ok(ids.includes(sinSucursal.id), 'el que se quedó sin sucursales sigue saliendo')
  assert.ok(ids.includes(huerfano.id), 'el que se quedó sin empresa también: si no, es irrecuperable')
  assert.ok(!ids.includes(ajeno.id), 'pero el de OTRA empresa no se filtra hacia acá')

  const marcado = lista.body.items.find((u) => u.id === huerfano.id)
  assert.strictEqual(marcado.in_company, false, 'y viene marcado como sin acceso a esta empresa')
  assert.strictEqual(marcado.branches.length, 0, 'sin sucursales')
  const completo = lista.body.items.find((u) => u.id === conTodo.id)
  assert.strictEqual(completo.in_company, true, 'el completo sí pertenece a la empresa')

  const ficha = await call(usuarios.getById, { ...req, params: { id: huerfano.id } })
  assert.strictEqual(ficha.status, 200, 'su ficha se puede abrir para devolverle el acceso')

  const fichaAjena = await call(usuarios.getById, { ...req, params: { id: ajeno.id } })
  assert.strictEqual(fichaAjena.status, 404, 'la de otra empresa no')

  console.log('users.orphan.selfcheck OK')
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
