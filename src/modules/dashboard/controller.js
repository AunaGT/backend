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

/**
 * GET /api/dashboard/stats
 * Obtiene las estadísticas principales del dashboard
 */
exports.getStats = async (req, res) => {
  try {
    // Obtener fecha de inicio del día en Guatemala (CST, UTC-6)
    const nowGt = DateTime.now().setZone('America/Guatemala');
    const startOfDayGt = nowGt.startOf('day');
    
    // Convertir a UTC para la consulta
    const startOfDayUtc = startOfDayGt.toUTC().toJSDate();
    const nowUtc = nowGt.toUTC().toJSDate();

    // 1. Ventas del día (solo ventas con estado Completado - id: 1)
    const STATUS_COMPLETADO = 1;

    const { branchWhere } = require('../../middlewares/tenant')
    const tenantSales = branchWhere(req)
    const salesAggregate = await prisma.sale.aggregate({
      where: {
        ...tenantSales,
        sold_at: { gte: startOfDayUtc, lte: nowUtc },
        status_id: STATUS_COMPLETADO
      },
      _sum: { 
        adjusted_total: true  // ✅ Usar adjusted_total (ventas netas con devoluciones)
      },
      _count: true
    });

    const ventasHoy = salesAggregate._sum.adjusted_total || 0;  // ✅ Ventas netas
    const cantidadVentasHoy = salesAggregate._count || 0;

    // 2 y 3. Stock y valor de inventario: de la sucursal activa (o total de la
    // empresa en vista consolidada, usando el espejo products.stock)
    let productosEnStock
    let valorInventario
    if (req.branchId) {
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
    await syncLotExpiryAlerts(prisma); // advisory, autothrottled; no hay cron en serverless
    const priorityCritica = await prisma.alertPriority.findFirst({
      where: { name: { in: ['Crítica', 'Critica'] } }
    });

    const statusActiva = await prisma.status.findFirst({
      where: { name: 'Activa' }
    });

    const alertasCriticasQuery = {
      ...branchWhere(req),
      resolved: 0,
      ...(statusActiva ? { status_id: statusActiva.id } : {}),
      ...(priorityCritica ? { priority_id: priorityCritica.id } : {})
    };

    const alertasCriticas = await prisma.alert.count({
      where: alertasCriticasQuery
    });

    // Calcular comparaciones con ayer (opcional para mostrar tendencias)
    const yesterdayStart = startOfDayGt.minus({ days: 1 }).toUTC().toJSDate();
    const yesterdayEnd = startOfDayGt.toUTC().toJSDate();

    const salesYesterday = await prisma.sale.aggregate({
      where: {
        ...tenantSales,
        sold_at: { gte: yesterdayStart, lt: yesterdayEnd },
        status_id: STATUS_COMPLETADO
      },
      _sum: { adjusted_total: true }  // ✅ Usar adjusted_total para comparación correcta
    });

    const ventasAyer = salesYesterday._sum.adjusted_total || 0;  // ✅ Ventas netas de ayer
    const cambioVentas = ventasAyer > 0 
      ? ((ventasHoy - ventasAyer) / ventasAyer * 100).toFixed(1)
      : 0;

    return res.json({
      ventasHoy: {
        valor: Number(ventasHoy.toFixed(2)),
        cantidad: cantidadVentasHoy,
        cambio: Number(cambioVentas),
        comparacion: 'vs ayer'
      },
      productosEnStock: {
        cantidad: productosEnStock,
        cambio: 0, // Se puede calcular comparando con días anteriores si es necesario
        comparacion: 'vs ayer'
      },
      valorInventario: {
        valor: Number(valorInventario.toFixed(2)),
        cambio: 0, // Se puede calcular comparando con snapshot anterior si es necesario
        comparacion: 'vs ayer'
      },
      alertasCriticas: {
        cantidad: alertasCriticas,
        cambio: 0, // Se puede calcular comparando con días anteriores si es necesario
        comparacion: 'vs ayer'
      },
      timestamp: nowGt.toISO(),
      timezone: 'America/Guatemala'
    });

  } catch (error) {
    console.error('[Dashboard Stats Error]', error);
    return res.status(500).json({ 
      error: 'Error al obtener estadísticas del dashboard',
      message: error.message 
    });
  }
};
