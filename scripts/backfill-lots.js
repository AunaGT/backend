#!/usr/bin/env node
/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * Cierra el descuadre de lotes en productos con `tracks_expiry`: por cada
 * ubicación donde la existencia física supera lo lotificado, abre un lote LEGACY
 * por la diferencia, para que la invariante SUMA(lotes) = existencia pueda
 * empezar a exigirse.
 *
 * Sin caducidad, porque genuinamente no se sabe cuál era: quedan de primeros en
 * FEFO para que alguien los revise físicamente y los corrija.
 *
 * Por defecto SOLO REPORTA. Para escribir hay que pasar --apply.
 *   node scripts/backfill-lots.js            # dry-run
 *   node scripts/backfill-lots.js --apply
 */
require('dotenv/config')
const { prisma } = require('../src/models/prisma')
const { generateLotCode } = require('../src/services/lots')

const APPLY = process.argv.includes('--apply')

async function main() {
  const productos = await prisma.product.findMany({
    where: { tracks_expiry: true, deleted: false },
    select: { id: true, name: true },
  })
  if (productos.length === 0) {
    console.log('No hay productos con control de caducidad. Nada que hacer.')
    return
  }
  console.log(`${productos.length} producto(s) con control de caducidad.\n`)

  let faltantes = 0
  let sobrantes = 0
  let unidades = 0
  const porCrear = []

  // Dos consultas para TODOS los productos, no dos por producto: contra una base
  // remota, 200 viajes de ida y vuelta tardan minutos.
  const ids = productos.map((p) => p.id)
  const nombre = new Map(productos.map((p) => [p.id, p.name]))
  const stocks = await prisma.productStockLocation.findMany({
    where: { product_id: { in: ids }, stock: { not: 0 } },
    select: {
      product_id: true, stock: true, location_id: true,
      location: { select: { code: true, warehouse: { select: { name: true, branch_id: true } } } },
    },
  })
  const lotes = await prisma.productLot.findMany({
    where: { product_id: { in: ids }, qty_remaining: { gt: 0 } },
    select: { product_id: true, qty_remaining: true, location_id: true },
  })
  const lotPorUbic = new Map()
  for (const l of lotes) {
    const k = `${l.product_id}|${l.location_id ?? ''}`
    lotPorUbic.set(k, (lotPorUbic.get(k) || 0) + Number(l.qty_remaining || 0))
  }

  for (const s of stocks) {
    const fisico = Number(s.stock || 0)
    const lotificado = lotPorUbic.get(`${s.product_id}|${s.location_id ?? ''}`) || 0
    const diff = fisico - lotificado
    if (diff === 0) continue
    const donde = `${s.location.warehouse.name} · ${s.location.code}`
    const quien = nombre.get(s.product_id)

    if (diff > 0) {
      faltantes++
      unidades += diff
      console.log(`  ${quien} — ${donde}: físico ${fisico}, con lote ${lotificado} -> falta ${diff}`)
      porCrear.push({
        product_id: s.product_id,
        branch_id: s.location.warehouse.branch_id,
        location_id: s.location_id,
        lot_code: `LEGACY-${generateLotCode().slice(2)}`,
        qty_received: diff,
        qty_remaining: diff,
      })
    } else {
      // Más unidades en lotes que en existencia: NO se toca. Borrar lotes
      // silenciosamente es perder trazabilidad; esto lo revisa una persona.
      sobrantes++
      console.log(`  ⚠️  ${quien} — ${donde}: con lote ${lotificado} SUPERA el físico ${fisico} por ${-diff}. Revisar a mano.`)
    }
  }

  if (APPLY && porCrear.length > 0) {
    await prisma.productLot.createMany({ data: porCrear })
  }

  console.log('')
  console.log(`Ubicaciones con faltante de lote: ${faltantes} (${unidades} unidades)`)
  console.log(`Ubicaciones con lotes de más:     ${sobrantes}  <- requieren revisión manual`)
  if (sobrantes > 0) {
    console.log('\nHay lotes que superan la existencia física. Eso no se corrige solo:')
    console.log('puede ser un ajuste que no descontó lotes o un lote mal ingresado.')
  }
  console.log(APPLY ? '\nCambios APLICADOS.' : '\nDry-run: no se escribió nada. Corré con --apply para aplicar.')
}

main()
  .catch((e) => { console.error('Error:', e.message); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
