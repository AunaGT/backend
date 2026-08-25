#!/usr/bin/env node
/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * `users` todavía tiene phone / address / hire_date / is_employee, que ahora son
 * datos de la ficha de empleado (RRHH). El código ya dejó de escribirlos, pero
 * las columnas siguen ahí con lo que se cargó antes.
 *
 * Este script dice qué pasaría si se borran:
 *   - usuarios CON ficha de empleado -> el dato se puede copiar a la ficha (--apply)
 *   - usuarios SIN ficha             -> el dato se perdería. Hay que decidir a mano.
 *
 * Por defecto SOLO REPORTA.
 *   node scripts/report-user-hr-fields.js
 *   node scripts/report-user-hr-fields.js --apply   # copia a la ficha existente
 */
require('dotenv/config')
const { prisma } = require('../src/models/prisma')

const APPLY = process.argv.includes('--apply')

async function main() {
  const users = await prisma.user.findMany({
    where: { OR: [{ phone: { not: null } }, { address: { not: null } }, { hire_date: { not: null } }, { is_employee: true }] },
    select: {
      id: true, name: true, email: true, phone: true, address: true, hire_date: true, is_employee: true,
      employee_record: { select: { id: true, code: true, phone: true, address: true } },
    },
    orderBy: { name: 'asc' },
  })

  if (users.length === 0) {
    console.log('Ningún usuario tiene datos de RRHH en su fila. Se pueden borrar las columnas sin perder nada.')
    return
  }

  const conFicha = users.filter((u) => u.employee_record)
  const sinFicha = users.filter((u) => !u.employee_record)
  let copiados = 0

  console.log(`${users.length} usuario(s) con datos de RRHH en la fila de usuario.\n`)

  if (conFicha.length) {
    console.log(`— CON ficha de empleado (${conFicha.length}): el dato tiene a dónde ir`)
    for (const u of conFicha) {
      // Solo se copia lo que la ficha NO tiene: la ficha es la fuente de verdad,
      // nunca se pisa un dato que RRHH ya cargó.
      const data = {}
      if (u.phone && !u.employee_record.phone) data.phone = u.phone
      if (u.address && !u.employee_record.address) data.address = u.address
      const que = Object.keys(data)
      console.log(`   ${u.name} (${u.employee_record.code}) -> ${que.length ? 'copiar ' + que.join(', ') : 'la ficha ya tiene todo, nada que copiar'}`)
      if (APPLY && que.length) {
        await prisma.employee.update({ where: { id: u.employee_record.id }, data })
        copiados++
      }
    }
    console.log('')
  }

  if (sinFicha.length) {
    console.log(`— SIN ficha de empleado (${sinFicha.length}): ⚠️  este dato SE PERDERÍA al borrar las columnas`)
    for (const u of sinFicha) {
      const tiene = [u.phone && 'teléfono', u.address && 'dirección', u.hire_date && 'ingreso', u.is_employee && 'marcado como empleado']
        .filter(Boolean).join(', ')
      console.log(`   ${u.name} <${u.email}> — ${tiene}`)
    }
    console.log('')
    console.log('   Para cada uno: si es empleado real, creale la ficha en RRHH y vinculá el usuario.')
    console.log('   Si no lo es (dueño, contador externo, integración), el dato simplemente sobra.')
  }

  console.log('')
  console.log(APPLY ? `Copiados a la ficha: ${copiados}` : 'Dry-run: no se escribió nada. Corré con --apply para copiar a las fichas existentes.')
  console.log(sinFicha.length === 0
    ? 'No queda nadie sin ficha: ya es seguro borrar las columnas.'
    : `Todavía NO borres las columnas: ${sinFicha.length} usuario(s) perderían datos.`)
}

main()
  .catch((e) => { console.error('Error:', e.message); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
