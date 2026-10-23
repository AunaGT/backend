/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

const { DateTime } = require('luxon')
const { decimal, storageQuantity } = require('./units/physical')

// Cache para catálogos (evitar consultas repetitivas)
let catalogCache = null
let cacheTime = null
const CACHE_TTL = 60000 // 1 minuto

async function lockStockAlertProducts(tx,productIds,branchId,{tryOnly=false}={}){
  const {Prisma}=require('@prisma/client')
  const keys=[...new Set(productIds.map(id=>`stock-alert:${branchId}:${id}`))].sort()
  if(!keys.length)return true
  const values=Prisma.join(keys.map(key=>Prisma.sql`(${key}::text)`))
  // Sort before invoking volatile locks; these guard alerts, not POS stock rows.
  if(tryOnly){
    const rows=await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended(key,0)) AS locked
      FROM (SELECT key FROM (VALUES ${values}) AS v(key) ORDER BY key) AS ordered`
    return rows.length===keys.length&&rows.every(row=>row.locked)
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(key,0))
    FROM (SELECT key FROM (VALUES ${values}) AS v(key) ORDER BY key) AS ordered`
  return true
}

async function getCatalogs(tx) {
  const now = Date.now()
  if (catalogCache && cacheTime && (now - cacheTime) < CACHE_TTL) {
    return catalogCache
  }

  const [statusActive, statusResolved, alertTypes, alertPriorities] = await Promise.all([
    tx.status.findFirst({ where: { name: 'Activa' } }),
    tx.status.findFirst({ where: { name: 'Resuelta' } }),
    tx.alertType.findMany(),
    tx.alertPriority.findMany(),
  ])

  catalogCache = {
    statusActive,
    statusResolved,
    alertTypes: Object.fromEntries(alertTypes.map(t => [t.name, t])),
    alertPriorities: Object.fromEntries(alertPriorities.map(p => [p.name, p])),
  }
  cacheTime = now
  return catalogCache
}

// Procesamiento en lote para múltiples productos. Las alertas de stock son
// POR SUCURSAL: stock/min_stock vienen de product_stocks de esa sucursal.
async function ensureStockAlertsBatch(tx, products, branchId, {strict=false,transactionBound=false,guardHeld=false}={}) {
  if (!products || products.length === 0) return
  if (!branchId) {
    if(strict)throw Object.assign(new Error('Sucursal requerida'),{code:'ALERT_BRANCH_REQUIRED'})
    console.error('[ensureStockAlertsBatch] branchId faltante; alertas omitidas')
    return
  }

  try {
    if(typeof tx.$transaction==='function'&&!transactionBound){
      return await tx.$transaction(client=>ensureStockAlertsBatch(client,products,branchId,{strict,transactionBound:true}),{timeout:30000,maxWait:5000})
    }
    // Obtener catálogos una sola vez para todo el lote
    const catalogs = await getCatalogs(tx)
    const { statusActive, statusResolved } = catalogs
    if (!statusActive || !statusResolved) {
      if(strict)throw Object.assign(new Error('Catálogos de alertas incompletos'),{code:'ALERT_CATALOG_REQUIRED'})
      return
    }

    if(!guardHeld){
      await lockStockAlertProducts(tx,products.map(p=>p.id),branchId)
      const current=await tx.productStock.findMany({where:{branch_id:branchId,product_id:{in:products.map(p=>p.id)}},select:{product_id:true,stock:true,min_stock:true}})
      products=current.map(({product_id,...row})=>({id:product_id,...row}))
    }

    const timestamp = DateTime.now().setZone('America/Guatemala').toJSDate()

    // Separar productos por estado de salud
    const healthyProductIds = []
    const unhealthyProducts = []

    products.forEach(({ id, stock, min_stock }) => {
      if (decimal(stock).gte(min_stock ?? 0)) {
        healthyProductIds.push(id)
      } else {
        unhealthyProducts.push({ id, stock, min_stock })
      }
    })

    // Operación 1: Resolver alertas de productos saludables en una sola query
    if (healthyProductIds.length > 0) {
      await tx.alert.updateMany({
        where: {
          product_id: { in: healthyProductIds },
          branch_id: branchId,
          status_id: statusActive.id,
          resolved: 0
        },
        data: { status_id: statusResolved.id, resolved: 1 }
      })
    }

    // Operación 2: Procesar productos no saludables
    if (unhealthyProducts.length === 0) return

    // Obtener todas las alertas activas existentes de una vez
    const existingAlerts = await tx.alert.findMany({
      where: {
        product_id: { in: unhealthyProducts.map(p => p.id) },
        branch_id: branchId,
        status_id: statusActive.id,
        resolved: 0
      },
      select: { id: true, product_id: true },
      orderBy: { timestamp: 'desc' }
    })

    const existingAlertsMap = new Map()
    existingAlerts.forEach(alert => {
      if (!existingAlertsMap.has(alert.product_id)) {
        existingAlertsMap.set(alert.product_id, alert.id)
      }
    })

    // Preparar updates y creates
    const updateOperations = []
    const createData = []

    unhealthyProducts.forEach(({ id: productId, stock, min_stock }) => {
      stock=decimal(stock)
      min_stock=decimal(min_stock)
      // Calcular prioridad y tipo
      let priorityName = 'Media'
      if (stock.isZero()) {
        priorityName = 'Crítica'
      } else {
        const ratio = min_stock.gt(0) ? stock.div(min_stock) : decimal(0)
        if (ratio.lte('0.25')) priorityName = 'Alta'
        else if (ratio.lte('0.6')) priorityName = 'Media'
        else priorityName = 'Baja'
      }
      const typeName = stock.isZero() ? 'Sin Stock' : 'Stock Bajo'

      const type = catalogs.alertTypes[typeName]
      const priority = catalogs.alertPriorities[priorityName]
      if(strict&&(!type||!priority))throw Object.assign(new Error('Catálogos de alertas incompletos'),{code:'ALERT_CATALOG_REQUIRED'})

      const alertData = {
        current_stock: storageQuantity(stock),
        min_stock: storageQuantity(min_stock),
        title: stock.isZero() ? 'Producto agotado' : 'Stock bajo',
        message: stock.isZero() ? 'El producto está sin existencias.' : `Stock por debajo del mínimo (${stock}/${min_stock}).`,
        timestamp,
        priority_id: priority?.id,
        type_id: type?.id,
      }

      const existingAlertId = existingAlertsMap.get(productId)
      if (existingAlertId) {
        // Actualizar alerta existente
        updateOperations.push(
          tx.alert.update({
            where: { id: existingAlertId },
            data: alertData
          })
        )
      } else {
        // Preparar para crear nueva alerta
        createData.push({
          product_id: productId,
          branch_id: branchId,
          ...alertData,
          status_id: statusActive.id,
          assigned_to: null,
          resolved: 0,
        })
      }
    })

    // Ejecutar todas las operaciones en paralelo
    const operations = [...updateOperations]
    
    // Crear alertas en lote si hay nuevas
    if (createData.length > 0) {
      operations.push(tx.alert.createMany({ data: createData, skipDuplicates: true }))
    }

    await Promise.all(operations)
  } catch (e) {
    if(strict)throw e
    console.error('[ensureStockAlertsBatch] ERROR:', e.message)
  }
}

// Versión individual (mantener por compatibilidad)
async function ensureStockAlert(tx, productId, newStock, minStock, branchId) {
  return ensureStockAlertsBatch(tx, [{ id: productId, stock: newStock, min_stock: minStock }], branchId)
}

module.exports = { ensureStockAlert, ensureStockAlertsBatch, lockStockAlertProducts }
