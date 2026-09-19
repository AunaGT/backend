/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

const { DateTime } = require('luxon');
const { prisma } = require('../../models/prisma');
const { syncLotExpiryAlerts } = require('../../services/lots');
const { branchWhere } = require('../../middlewares/tenant');
const { getTimezone } = require('../../utils/getTimezone');
const { buildPeriodRanges, buildPeriodSummary } = require('./domain');

function isAdmin(user) {
  const role = user?.role?.name || user?.role_name
  return typeof role === 'string' && role.toLowerCase() === 'admin'
}

function can(user, permission) {
  return isAdmin(user) || (Array.isArray(user?.permissions) && user.permissions.includes(permission))
}

function moduleEnabled(req, code) {
  return (req.companyModules || []).some((module) => module.code === code && module.effectiveEnabled)
}

/**
 * GET /api/dashboard/stats
 * Obtiene las estadísticas principales del dashboard
 */
exports.getStats = async (req, res) => {
  try {
    const timezone = await getTimezone(prisma, req.companyId)
    const nowLocal = DateTime.now().setZone(timezone);
    const nowUtc = nowLocal.toUTC().toJSDate();

    // Ventas completadas: un solo recorrido alimenta hoy, semana y mes. También
    // incluye el tramo comparable anterior para no enfrentar un día parcial con
    // un día completo.
    const STATUS_COMPLETADO = 1;
    const tenantSales = branchWhere(req)
    const ranges = buildPeriodRanges(nowLocal, timezone)
    const earliestStart = ranges.month.previous.start
    const sales = await prisma.sale.findMany({
      where: {
        ...tenantSales,
        sold_at: { gte: earliestStart, lte: nowUtc },
        status_id: STATUS_COMPLETADO
      },
      select: {
        sold_at: true,
        adjusted_total: true,
        sale_items: {
          select: {
            qty: true,
            unit_cost: true,
            product: { select: { cost: true } },
          },
        },
      },
    });
    const periods = buildPeriodSummary(sales, ranges)
    const ventasHoy = periods.today.sales
    const cantidadVentasHoy = periods.today.transactions

    // 2 y 3. Stock y valor de inventario: de la sucursal activa (o total de la
    // empresa en vista consolidada, usando el espejo products.stock)
    let productosEnStock
    let valorInventario
    const canViewInventory = moduleEnabled(req, 'inventory') && can(req.user, 'products.view')
    if (!canViewInventory) {
      productosEnStock = null
      valorInventario = null
    } else if (req.branchId) {
      const rows = await prisma.productStock.findMany({
        where: { branch_id: req.branchId, product: { deleted_at: null } },
        select: { stock: true, product: { select: { cost: true } } },
      })
      productosEnStock = rows.filter((r) => r.stock > 0).length
      // Valor de inventario = unidades × costo unitario (no precio de venta).
      valorInventario = rows.reduce((sum, r) => sum + Number(r.product.cost || 0) * Number(r.stock || 0), 0)
    } else {
      productosEnStock = await prisma.product.count({
        where: { stock: { gt: 0 }, deleted_at: null, company_id: req.companyId }
      })
      const productos = await prisma.product.findMany({
        where: { deleted_at: null, company_id: req.companyId },
        select: { cost: true, stock: true }
      })
      valorInventario = productos.reduce((sum, p) => sum + Number(p.cost || 0) * Number(p.stock || 0), 0)
    }

    // 4. Alertas críticas (alertas activas no resueltas con prioridad "Crítica")
    let alertasCriticas = null
    if (moduleEnabled(req, 'alerts') && (can(req.user, 'alerts.view') || can(req.user, 'alerts.manage'))) {
      await syncLotExpiryAlerts(prisma); // advisory, autothrottled; no hay cron en serverless
      const [priorityCritica, statusActiva] = await Promise.all([
        prisma.alertPriority.findFirst({ where: { name: { in: ['Crítica', 'Critica'] } } }),
        prisma.status.findFirst({ where: { name: 'Activa' } }),
      ])
      alertasCriticas = await prisma.alert.count({
        where: {
          ...branchWhere(req),
          resolved: 0,
          ...(statusActiva ? { status_id: statusActiva.id } : {}),
          ...(priorityCritica ? { priority_id: priorityCritica.id } : {})
        }
      })
    }

    let pendingCashDifferences = null
    if (moduleEnabled(req, 'cash-closure') && can(req.user, 'cashclosure.view')) {
      const pendingClosures = await prisma.cashClosure.findMany({
        where: { ...branchWhere(req), status: 'Pendiente' },
        select: { difference: true },
      })
      const withDifference = pendingClosures.filter((closure) => Math.abs(Number(closure.difference) || 0) >= 0.005)
      pendingCashDifferences = {
        count: withDifference.length,
        amount: Number(withDifference.reduce((sum, closure) => sum + Math.abs(Number(closure.difference) || 0), 0).toFixed(2)),
      }
    }

    return res.json({
      ventasHoy: {
        valor: ventasHoy,
        cantidad: cantidadVentasHoy,
        cambio: periods.today.salesChange,
        comparacion: 'vs ayer'
      },
      productosEnStock: {
        cantidad: productosEnStock,
        cambio: 0, // Se puede calcular comparando con días anteriores si es necesario
        comparacion: 'vs ayer'
      },
      valorInventario: {
        valor: valorInventario == null ? null : Number(valorInventario.toFixed(2)),
        cambio: 0, // Se puede calcular comparando con snapshot anterior si es necesario
        comparacion: 'vs ayer'
      },
      alertasCriticas: {
        cantidad: alertasCriticas,
        cambio: 0, // Se puede calcular comparando con días anteriores si es necesario
        comparacion: 'vs ayer'
      },
      periods,
      pendingCashDifferences,
      timestamp: nowLocal.toISO(),
      timezone
    });

  } catch (error) {
    console.error('[Dashboard Stats Error]', error);
    return res.status(500).json({ 
      error: 'Error al obtener estadísticas del dashboard',
      message: error.message 
    });
  }
};
