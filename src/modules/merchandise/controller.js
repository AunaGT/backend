/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

const { prisma, prismaTransaction } = require('../../models/prisma')
const { payableScope, entryWhere, cancelLegacyEntry } = require('./payables')
const { shapePaymentBalance, addIndividualPayment, changePaymentConditions } = require('./payables/compatibility')
const {balanceOf}=require('./payables/balance')
const {Prisma}=require('@prisma/client')
const { DateTime } = require('luxon')
const PDFDocument = require('pdfkit')
const { getBrandingForPdf, PDF_COLORS, setupReportPdf, ensureReportSpace, drawReportTable, finishReportPdf } = require('../../utils/pdfBranding')

function computeMerchandiseTotal (items) {
  if (!items || !items.length) return 0
  return items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_cost), 0)
}

function roundMoney (n) {
  return Math.round(n * 100) / 100
}
const advancedItem=item=>item.unit_metadata_version===2&&item.unit_snapshot?.version===2
const exact=value=>new Prisma.Decimal(String(value)).toFixed()
function incomingItem(item,product=item.product){
  const legacy={id:item.id,product,quantity:item.quantity,unit_cost:item.unit_cost}
  if(!advancedItem(item))return {...legacy,...(item.line_total!=null?{line_total:new Prisma.Decimal(String(item.line_total)).toFixed(2),subtotal:new Prisma.Decimal(String(item.line_total)).toFixed(2)}:{subtotal:Number(item.quantity)*Number(item.unit_cost)})}
  return {...legacy,quantity:exact(item.quantity),unit_cost:exact(item.unit_cost),unit_metadata_version:2,unit_snapshot:item.unit_snapshot,unit_label:item.unit_snapshot.presentation?.label??item.unit_snapshot.baseUnit.label,base_qty:exact(item.base_qty),base_unit_cost:exact(item.base_unit_cost),line_total:new Prisma.Decimal(String(item.line_total)).toFixed(2),subtotal:new Prisma.Decimal(String(item.line_total)).toFixed(2)}
}

const incomingDetailInclude = {
  supplier: {
    select: {
      id: true,
      name: true,
      contact: true,
      email: true,
      phone: true,
      supplier_payment_terms: { select: { payment_term: { select: { id: true, name: true, net_days: true } } }, orderBy: { sort_order: 'asc' } }
    }
  },
  registeredBy: {
    select: {
      id: true,
      name: true,
      email: true
    }
  },
  paymentTerm: {
    select: {
      id: true,
      name: true,
      net_days: true
    }
  },
  paymentUpdatedBy: {
    select: {
      id: true,
      name: true,
      email: true
    }
  },
  items: {
    include: {
      product: {
        select: {
          id: true,
          name: true,
          brand: true,
          size: true,
          barcode: true,
          image_url: true,
          cost: true,
          price: true,
          stock: true
        }
      }
    },
    orderBy: {
      product: {
        name: 'asc'
      }
    }
  },
  payment_audit: { orderBy: { created_at: 'desc' }, take: 100, include: { actor: { select: { id: true, name: true } } } },
  paymentEntries: {
    include: {
      registeredBy: {
        select: {
          id: true,
          name: true,
          email: true
        }
      }
    },
    orderBy: { paid_at: 'desc' }
  }
}

function shapePaymentEntries (entries) {
  return (entries || []).map((e) => ({
    id: e.id,
    amount: roundMoney(Number(e.amount)),
    supplier_payment_id: e.supplier_payment_id || null,
    cancelled_at: e.cancelled_at || null,
    cancel_reason: e.cancel_reason || null,
    paid_at: e.paid_at,
    reference: e.reference,
    registered_by: e.registeredBy
      ? {
          id: e.registeredBy.id,
          name: e.registeredBy.name,
          email: e.registeredBy.email
        }
      : null
  }))
}

function shapeIncomingDetail (record) {
  const advanced=record.items.some(advancedItem)
  const exactBalance=advanced?balanceOf(record):null
  const balance = exactBalance?{payment_status:exactBalance.status==='REVIEW'?record.payment_status:exactBalance.status,totalValue:exactBalance.total,amount_paid_total:exactBalance.documentedPaid,legacy_settled_amount:exactBalance.legacySettled,amount_pending:exactBalance.balance,payment_balance_review_required:exactBalance.status==='REVIEW',payment_revision:exactBalance.revision}:shapePaymentBalance(record)
  const entries = record.paymentEntries || []
  const { supplier_payment_terms: termLinks = [], ...supplier } = record.supplier || {id:null,name:record.source==='PRODUCTION'?'Fabricación propia':'Existencias iniciales'}
  return {
    id: record.id,
    ...(advanced?{unit_metadata_version:2,itemsCount:record.items.length}:{}),
    source: record.source,
    production_details: record.production_details || null,
    supplier,
    payment_terms: termLinks.map(link => link.payment_term),
    registeredBy: record.registeredBy,
    date: record.date,
    notes: record.notes,
    payment_term: record.paymentTerm
      ? {
          id: record.paymentTerm.id,
          name: record.paymentTerm.name,
          net_days:
            record.paymentTerm.net_days != null ? Number(record.paymentTerm.net_days) : null
        }
      : null,
    payment_status: record.payment_status,
    paid_at: record.paid_at,
    payment_reference: record.payment_reference,
    due_date: record.due_date,
    payment_updated_at: record.payment_updated_at,
    payment_updated_by: record.paymentUpdatedBy
      ? {
          id: record.paymentUpdatedBy.id,
          name: record.paymentUpdatedBy.name,
          email: record.paymentUpdatedBy.email
        }
      : null,
    payment_entries: shapePaymentEntries(entries),
    ...balance,
    payment_audit: record.payment_audit || [],
    items: record.items.map(item=>incomingItem(item))
  }
}

/** Los dos accesos de pago usan el mismo libro y las mismas transacciones. */
function paymentError(e,res,next) {
  if(e.status) return res.status(e.status).json({message:e.message,code:e.code,data:e.data})
  next(e)
}
async function sendPaymentDetail(req,res) {
  const record=await prisma.incomingMerchandise.findFirst({where:{id:req.params.id,...entryWhere(payableScope(req))},include:incomingDetailInclude})
  res.json(shapeIncomingDetail(record))
}
exports.addPaymentEntry=async(req,res,next)=>{
  try { await addIndividualPayment(prismaTransaction,payableScope(req),req.params.id,req.body||{},req.get?.('Idempotency-Key'));await sendPaymentDetail(req,res) }
  catch(e){paymentError(e,res,next)}
}
exports.deletePaymentEntry=async(req,res,next)=>{
  try { await cancelLegacyEntry(prismaTransaction,payableScope(req),req.params.id,req.params.entryId,req.body||{});await sendPaymentDetail(req,res) }
  catch(e){paymentError(e,res,next)}
}

/**
 * List all incoming merchandise records with pagination
 * GET /api/incoming-merchandise
 */
exports.list = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page ?? 1))
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)))
    const { supplier_id, start_date, end_date, search, payment_status } = req.query || {}

    const { branchWhere } = require('../../middlewares/tenant')
    const where = { ...branchWhere(req) }

    // Filter by supplier
    if (supplier_id) {
      where.supplier_id = String(supplier_id)
    }

    if (payment_status === 'PENDING' || payment_status === 'PAID' || payment_status === 'PARTIAL') {
      where.payment_status = payment_status
      where.source = 'PURCHASE'
    }

    // Filter by date range
    if (start_date || end_date) {
      where.date = {}
      if (start_date) {
        where.date.gte = new Date(start_date)
      }
      if (end_date) {
        where.date.lte = new Date(end_date)
      }
    }

    // Search by supplier name or notes
    if (search) {
      where.OR = [
        { supplier: { name: { contains: String(search), mode: 'insensitive' } } },
        { notes: { contains: String(search), mode: 'insensitive' } },
        { registeredBy: { name: { contains: String(search), mode: 'insensitive' } } }
      ]
    }

    let totalItems
    let summary
    if (req.query.includeSummary === 'true') {
      const groups = await prisma.incomingMerchandise.groupBy({ by: ['source','payment_status'], where, _count: { _all: true } })
      totalItems = groups.reduce((total, group) => total + group._count._all, 0)
      const counts = groups.filter(group=>(group.source||'PURCHASE')==='PURCHASE').reduce((all,group)=>{all[group.payment_status]=(all[group.payment_status]||0)+group._count._all;return all},{})
      summary = { total: totalItems, paid: counts.PAID ?? 0, partial: counts.PARTIAL ?? 0, pending: counts.PENDING ?? 0 }
    } else totalItems = await prisma.incomingMerchandise.count({ where })
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    const safePage = Math.min(page, totalPages)

    const records = await prisma.incomingMerchandise.findMany({
      where,
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            contact: true
          }
        },
        registeredBy: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        paymentTerm: {
          select: {
            id: true,
            name: true
          }
        },
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                brand: true,
                size: true,
                barcode: true
              }
            }
          }
        }
      },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      skip: (safePage - 1) * pageSize,
      take: pageSize,
    })

    // Calculate total value for each record
    const adapted = records.map(record => {
      const advanced=record.items.some(advancedItem)
      const totalValue = advanced||record.source==='PRODUCTION'||record.source==='INITIAL'?balanceOf(record).total:record.items.reduce((sum, item) => {
        return sum + (Number(item.quantity) * Number(item.unit_cost))
      }, 0)

      return {
        id: record.id,
        source: record.source,
        ...(advanced?{unit_metadata_version:2}:{}),
        supplier: {
          id: record.supplier?.id || null,
          name: record.supplier?.name || (record.source==='PRODUCTION'?'Fabricación propia':'Existencias iniciales'),
          contact: record.supplier?.contact || null
        },
        registeredBy: {
          id: record.registeredBy.id,
          name: record.registeredBy.name,
          email: record.registeredBy.email
        },
        date: record.date,
        notes: record.notes,
        payment_term: record.paymentTerm
          ? { id: record.paymentTerm.id, name: record.paymentTerm.name }
          : null,
        payment_status: record.payment_status,
        paid_at: record.paid_at,
        payment_reference: record.payment_reference,
        due_date: record.due_date,
        itemsCount: record.items.length,
        totalValue,
        items: record.items.map(item => incomingItem(item,{
            id: item.product.id,
            name: item.product.name,
            brand: item.product.brand,
            size: item.product.size,
            barcode: item.product.barcode
          }))
      }
    })

    const nextPage = safePage < totalPages ? safePage + 1 : null
    const prevPage = safePage > 1 ? safePage - 1 : null

    res.json({
      items: adapted,
      ...(summary ? { summary } : {}),
      page: safePage,
      pageSize,
      totalPages,
      totalItems,
      nextPage,
      prevPage
    })
  } catch (e) {
    next(e)
  }
}

/**
 * Get a single incoming merchandise record by ID
 * GET /api/incoming-merchandise/:id
 */
exports.getById = async (req, res, next) => {
  try {
    const { id } = req.params

    const record = await prisma.incomingMerchandise.findFirst({
      where: { id, ...entryWhere(payableScope(req)) },
      include: incomingDetailInclude
    })

    if (!record) {
      return res.status(404).json({ message: 'Registro de mercancía no encontrado' })
    }

    res.json(shapeIncomingDetail(record))
  } catch (e) {
    next(e)
  }
}

/**
 * Actualizar solo datos de pago (sin tocar stock ni ítems)
 * PATCH /api/incoming-merchandise/:id/payment
 */
exports.updatePayment=async(req,res,next)=>{
  try { await changePaymentConditions(prismaTransaction,payableScope(req),req.params.id,req.body||{},req.get?.('Idempotency-Key'));await sendPaymentDetail(req,res) }
  catch(e){paymentError(e,res,next)}
}

/**
 * Generate PDF report for incoming merchandise
 * GET /api/incoming-merchandise/report
 */
exports.generateReport = async (req, res, next) => {
  try {
    const { supplier_id, start_date, end_date, payment_status, search } = req.query || {}

    const { branchWhere } = require('../../middlewares/tenant')
    const where = { ...branchWhere(req) }
    if (search) {
      where.OR = [
        { supplier: { name: { contains: String(search), mode: 'insensitive' } } },
        { notes: { contains: String(search), mode: 'insensitive' } },
        { registeredBy: { name: { contains: String(search), mode: 'insensitive' } } }
      ]
    }

    if (supplier_id) {
      where.supplier_id = String(supplier_id)
    }

    if (payment_status === 'PENDING' || payment_status === 'PAID' || payment_status === 'PARTIAL') {
      where.payment_status = payment_status
      where.source = 'PURCHASE'
    }

    if (start_date || end_date) {
      where.date = {}
      if (start_date) {
        where.date.gte = new Date(start_date)
      }
      if (end_date) {
        where.date.lte = new Date(end_date)
      }
    }

    const records = await prisma.incomingMerchandise.findMany({
      where,
      include: {
        supplier: {
          select: {
            name: true,
            contact: true
          }
        },
        registeredBy: {
          select: {
            name: true
          }
        },
        paymentTerm: {
          select: {
            id: true,
            name: true
          }
        },
        items: {
          include: {
            product: {
              select: {
                name: true,
                brand: true,
                size: true
              }
            }
          }
        }
      },
      orderBy: { date: 'desc' }
    })

    const branding = await getBrandingForPdf(prisma, req.companyId)
    const doc = new PDFDocument({ margin: 50, bufferPages: true })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename="reporte-mercancia.pdf"')
    doc.pipe(res)
    const metadata = []
    if (start_date || end_date) metadata.push(`Período: ${start_date ? new Date(start_date).toLocaleDateString('es-GT') : 'Inicio'} - ${end_date ? new Date(end_date).toLocaleDateString('es-GT') : 'Fin'}`)
    if (['PENDING', 'PAID', 'PARTIAL'].includes(payment_status)) metadata.push(`Estado de pago: ${payment_status === 'PAID' ? 'Pagado' : payment_status === 'PARTIAL' ? 'Pago parcial' : 'Pendiente'}`)
    setupReportPdf(doc, { branding, title: 'Reporte de Ingresos de Mercancía', metadata })
    let totalGeneral = 0
    for (const [index, record] of records.entries()) {
      const recordTotal = record.items.reduce((sum, item) => sum.add(item.line_total??new Prisma.Decimal(String(item.quantity)).mul(String(item.unit_cost))),new Prisma.Decimal(0)).toNumber()
      totalGeneral += recordTotal
      ensureReportSpace(doc, 110)
      doc.font('Helvetica-Bold').fontSize(11).fillColor(PDF_COLORS.navy).text(`Registro #${index + 1}`)
      const details = [
        `Fecha: ${new Date(record.date).toLocaleDateString('es-GT')}`,
        `Origen / proveedor: ${record.supplier?.name || (record.source==='PRODUCTION'?'Fabricación propia':'Existencias iniciales')}`,
        `Registrado por: ${record.registeredBy.name}`,
        ...((record.source||'PURCHASE')==='PURCHASE'?[
          `Término de pago: ${record.paymentTerm?.name || '—'}`,
          `Estado: ${record.payment_status === 'PAID' ? 'Pagado' : record.payment_status === 'PARTIAL' ? 'Pago parcial' : 'Pendiente de pago'}`,
          ...(record.paid_at ? [`Fecha de pago: ${new Date(record.paid_at).toLocaleString('es-GT')}`] : []),
          ...(record.due_date ? [`Vencimiento: ${new Date(record.due_date).toLocaleDateString('es-GT')}`] : []),
          ...(record.payment_reference ? [`Referencia: ${record.payment_reference}`] : []),
        ]:['Estado: Sin cuentas por pagar']),
        ...(record.notes ? [`Notas: ${record.notes}`] : []),
      ]
      doc.font('Helvetica').fontSize(9).fillColor(PDF_COLORS.muted)
      for (const detail of details) {
        ensureReportSpace(doc, doc.heightOfString(detail, { width: doc.page.width - 100 }) + 5)
        doc.text(detail, doc.page.margins.left, doc.y, { width: doc.page.width - 100 })
        doc.y += 3
      }
      doc.y += 5
      drawReportTable(doc, ['Productos', 'Cantidad', 'Costo unitario', 'Subtotal'], record.items.map(item => [
        `${item.product.name} ${item.product.brand || ''} ${item.product.size || ''}`.trim(),
        String(item.quantity), `Q${Number(item.unit_cost).toFixed(2)}`, `Q${(Number(item.quantity) * Number(item.unit_cost)).toFixed(2)}`,
      ]), { widths: [260, 65, 90, 90], align: ['left', 'right', 'right', 'right'] })
      ensureReportSpace(doc, 35)
      doc.font('Helvetica-Bold').fontSize(10).fillColor(PDF_COLORS.navy).text(`Total del registro: Q${recordTotal.toFixed(2)}`, { align: 'right' })
      doc.y += 15
    }
    ensureReportSpace(doc, 35)
    doc.font('Helvetica-Bold').fontSize(14).fillColor(PDF_COLORS.navy).text(`Total General: Q${totalGeneral.toFixed(2)}`, { align: 'right' })
    finishReportPdf(doc)

    doc.end()
  } catch (e) {
    next(e)
  }
}
