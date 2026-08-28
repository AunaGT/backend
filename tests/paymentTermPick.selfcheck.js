/**
 * Qué término de pago se le aplica a un cliente.
 *
 * Existe porque la pantalla de venta y el cálculo del vencimiento leían el
 * término por su cuenta, filtrando `is_default: true`: un cliente con término
 * asignado pero sin marcar quedaba como si no tuviera ninguno, y la factura
 * salía sin vencimiento. Ahora las dos usan CUSTOMER_TERM_PICK; esto verifica
 * que ese pick sea una consulta válida y elija lo mismo que muestra la ficha.
 *
 *   DATABASE_URL=... node tests/paymentTermPick.selfcheck.js
 */

const { PrismaClient } = require('@prisma/client')
const { CUSTOMER_TERM_PICK } = require('../src/services/receivables')

const prisma = new PrismaClient()
const assert = (cond, msg) => {
  if (!cond) {
    console.error('FALLO:', msg)
    process.exit(1)
  }
  console.log('ok:', msg)
}

async function main() {
  const co = await prisma.company.create({
    data: { name: 'QA terminos', code: 'QATERM' + Date.now() },
  })
  const term = (name, net_days) =>
    prisma.paymentTerm.create({ data: { company_id: co.id, name, net_days } })
  const t7 = await term('7 dias', 7)
  const t30 = await term('30 dias', 30)
  const sinDias = await term('60 dias', null)

  const cliente = (name, links) =>
    prisma.supplier.create({
      data: {
        company_id: co.id, name, contact: 'QA', party_type: 'CUSTOMER',
        supplier_payment_terms: { create: links },
      },
    })
  const a = await cliente('Con predeterminado', [
    { payment_term_id: t7.id, is_default: false, sort_order: 0 },
    { payment_term_id: t30.id, is_default: true, sort_order: 1 },
  ])
  const b = await cliente('Sin marcar predeterminado', [
    { payment_term_id: t7.id, is_default: false, sort_order: 0 },
  ])
  const c = await cliente('Termino sin dias', [
    { payment_term_id: sinDias.id, is_default: true, sort_order: 0 },
  ])

  const pick = async (id) => {
    const s = await prisma.supplier.findFirst({
      where: { id, company_id: co.id },
      select: { id: true, supplier_payment_terms: CUSTOMER_TERM_PICK },
    })
    return s.supplier_payment_terms[0]?.payment_term ?? null
  }

  assert((await pick(a.id))?.net_days === 30, 'gana el marcado como predeterminado, no el primero')
  assert((await pick(b.id))?.net_days === 7, 'sin ninguno marcado cae al primero')

  // El nombre puede decir "60 dias" y el término no tener días: no hay fecha
  // que sugerir, y el POS tiene que poder distinguirlo de "no tiene término".
  const sin = await pick(c.id)
  assert(sin != null && sin.net_days == null, 'termino sin dias llega como termino, no como null')

  console.log('terminos de pago: OK')
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
