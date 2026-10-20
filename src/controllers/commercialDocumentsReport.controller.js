/**
 * Reportes operativos: stock comprometido y pedidos abiertos.
 */

const { prisma } = require('../models/prisma')
const { getAvailabilityBatch } = require('../services/stockAvailability')
const {D,baseUnit,dimension,attachBaseUnits,quantityTotal}=require('../modules/reports/quantities')
const { requireBranch, branchWhere } = require('../middlewares/tenant')

exports.committedStockReport = async (req, res, next) => {
  try {
    const branchId = requireBranch(req)
    const activeReservations = await prisma.stockReservation.findMany({
      where: { status: 'ACTIVE', branch_id: branchId,product:{company_id:req.companyId} },
      include: {
        product: { select: { id: true, name: true, barcode: true, stock: true } },
        document: {
          select: {
            id: true,
            reference: true,
            doc_type: true,
            status: true,
            customer: true,
            valid_until: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
    })

    const byProduct = new Map()
    for (const r of activeReservations) {
      const pid = r.product_id
      if (!byProduct.has(pid)) {
        byProduct.set(pid, {
          product_id: pid,
          name: r.product?.name || pid,
          barcode: r.product?.barcode || null,
          stock: String(r.product?.stock ?? 0),
          reserved: 0,
          reservations: [],
        })
      }
      const row = byProduct.get(pid)
      row.reserved = D(row.reserved).add(D(r.qty)).toFixed()
      row.reservations.push({
        reservation_id: r.id,
        qty: String(r.qty),
        document_id: r.document_id,
        reference: r.document?.reference,
        doc_type: r.document?.doc_type,
        status: r.document?.status,
        customer: r.document?.customer,
        valid_until: r.document?.valid_until,
      })
    }

    const productIds = [...byProduct.keys()]
    const availability = await getAvailabilityBatch(productIds, null, { branchId })

    await attachBaseUnits(prisma,req.companyId,[...byProduct.values()],'product_id')
    const products = [...byProduct.values()].map((p) => ({
      ...p,unit_label:baseUnit(p),
      available: String(availability[p.product_id]?.available ?? (D(p.stock).sub(D(p.reserved)).gt(0)?D(p.stock).sub(D(p.reserved)).toFixed():'0')),
    }))
    products.sort((a, b) => D(b.reserved).cmp(D(a.reserved)))

    const openOrders = await prisma.commercialDocument.findMany({
      where: {
        doc_type: 'ORDER',
        status: { in: ['DRAFT', 'CONFIRMED'] },
        ...branchWhere(req),
      },
      select: {
        id: true,
        reference: true,
        status: true,
        customer: true,
        total: true,
        valid_until: true,
        confirmed_at: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
      take: 100,
    })

    const openQuotes = await prisma.commercialDocument.findMany({
      where: {
        doc_type: 'QUOTE',
        status: { in: ['DRAFT', 'SENT', 'ACCEPTED'] },
        ...branchWhere(req),
      },
      select: {
        id: true,
        reference: true,
        status: true,
        customer: true,
        total: true,
        valid_until: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
      take: 100,
    })

    const totalReservedQty = quantityTotal(products.map(p=>({...p,dimension:dimension(p)})),'reserved')

    res.json({
      summary: {
        totalReservedQty,
        productsWithReservations: products.length,
        openOrders: openOrders.length,
        openQuotes: openQuotes.length,
      },
      products,
      openOrders,
      openQuotes,
    })
  } catch (e) {
    next(e)
  }
}
