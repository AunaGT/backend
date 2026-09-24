const test = require('node:test')
const assert = require('node:assert/strict')

function responseStub() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

function loadOrdersController(t, prisma) {
  const controllerPath = require.resolve('../src/modules/orders/controller')
  const prismaPath = require.resolve('../src/models/prisma')
  const cachedController = require.cache[controllerPath]
  const cachedPrisma = require.cache[prismaPath]

  require.cache[prismaPath] = { exports: { prisma, prismaTransaction: prisma } }
  delete require.cache[controllerPath]
  const controller = require(controllerPath)

  t.after(() => {
    if (cachedController) require.cache[controllerPath] = cachedController
    else delete require.cache[controllerPath]
    if (cachedPrisma) require.cache[prismaPath] = cachedPrisma
    else delete require.cache[prismaPath]
  })
  return controller
}

test('actualiza despacho y notas dentro de la empresa del administrador', async (t) => {
  let lookupWhere
  let updateData
  const updated = { id: 'order-a', delivery_carrier: 'Auna Logistics', notes: 'Llamar antes' }
  const prisma = {
    commercialDocument: {
      findFirst: async ({ where }) => { lookupWhere = where; return { id: 'order-a' } },
      update: async ({ data }) => { updateData = data; return updated },
    },
  }
  const controller = loadOrdersController(t, prisma)
  const res = responseStub()
  let error

  await controller.updateAdminDetails({
    params: { id: 'PED-1' },
    companyId: 'company-a',
    body: { delivery_carrier: ' Auna Logistics ', notes: ' Llamar antes ' },
  }, res, (value) => { error = value })

  assert.equal(error, undefined)
  assert.deepEqual(lookupWhere.branch, { company_id: 'company-a' })
  assert.deepEqual(updateData, { delivery_carrier: 'Auna Logistics', notes: 'Llamar antes' })
  assert.equal(res.body, updated)
})
