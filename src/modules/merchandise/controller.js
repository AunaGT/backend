/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

const { prisma } = require('../../models/prisma')
const { DateTime } = require('luxon')
const PDFDocument = require('pdfkit')
const { getBrandingForPdf } = require('../../utils/pdfBranding')

const ROUND_EPS = 0.005

/** Prisma interactive tx default timeout is 5s; abonos hacen varias lecturas + sync. */
const PAYMENT_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 }

function computeMerchandiseTotal (items) {
  if (!items || !items.length) return 0
  return items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_cost), 0)
}

function roundMoney (n) {
  return Math.round(n * 100) / 100
}

const incomingDetailInclude = {
  supplier: {
    select: {
      id: true,
      name: true,
      contact: true,
      email: true,
      phone: true
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
  const totalValue = computeMerchandiseTotal(record.items)
  const entries = record.paymentEntries || []
  const amountPaidTotal = roundMoney(entries.reduce((s, e) => s + Number(e.amount), 0))
  const amountPending = Math.max(0, roundMoney(totalValue - amountPaidTotal))
  return {
    id: record.id,
    supplier: record.supplier,
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
    amount_paid_total: amountPaidTotal,
    amount_pending: amountPending,
    totalValue,
    items: record.items.map(item => ({
      id: item.id,
      product: item.product,
      quantity: item.quantity,
      unit_cost: item.unit_cost,
      subtotal: Number(item.quantity) * Number(item.unit_cost)
    }))
  }
}

/**
 * Recalcula estado PAID / PARTIAL / PENDING según suma de abonos vs total del ingreso.
 */
async function syncMerchandisePaymentStatus (incomingMerchandiseId, editorUserId, db = prisma) {
  const record = await db.incomingMerchandise.findUnique({
    where: { id: incomingMerchandiseId },
    include: { items: true, paymentEntries: true }
  })
  if (!record) return
  const total = computeMerchandiseTotal(record.items)
  const sumPaid = (record.paymentEntries || []).reduce((s, e) => s + Number(e.amount), 0)
  let status = 'PENDING'
  let paidAt = null
  if (sumPaid >= total - ROUND_EPS) {
    status = 'PAID'
    const sorted = [...(record.paymentEntries || [])].sort(
      (a, b) => new Date(b.paid_at) - new Date(a.paid_at)
    )
    paidAt = sorted[0]?.paid_at || new Date()
  } else if (sumPaid > ROUND_EPS) {
    status = 'PARTIAL'
  }
  await db.incomingMerchandise.update({
    where: { id: incomingMerchandiseId },
    data: {
      payment_status: status,
      paid_at: paidAt,
      payment_updated_by: editorUserId,
      payment_updated_at: new Date()
    }
  })
}

/**
 * Registrar abono parcial
 * POST /api/incoming-merchandise/:id/payments
 */
exports.addPaymentEntry = async (req, res, next) => {
  try {
    const { id } = req.params
    const body = req.body || {}
    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: 'amount debe ser un número mayor a 0' })
    }
    let paidAt = new Date()
    if (body.paid_at != null && body.paid_at !== '') {
      const p = new Date(body.paid_at)
      if (Number.isNaN(p.getTime())) {
        return res.status(400).json({ message: 'paid_at inválido' })
      }
      paidAt = p
    }
    let reference = body.reference != null ? String(body.reference).trim() : ''
    if (reference.length > 255) reference = reference.slice(0, 255)
    reference = reference || null

    const uid = req.user?.sub
    if (!uid) {
      return res.status(401).json({ message: 'Usuario no autenticado' })
    }

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.incomingMerchandise.findUnique({
        where: { id },
        include: { items: true, paymentEntries: true }
      })
      if (!existing) {
        return null
      }
      const total = computeMerchandiseTotal(existing.items)
      const sumExisting = (existing.paymentEntries || []).reduce((s, e) => s + Number(e.amount), 0)
      if (sumExisting + amount > total + ROUND_EPS) {
        throw new Error('EXCEEDS')
      }

      await tx.incomingMerchandisePaymentEntry.create({
        data: {
          incoming_merchandise_id: id,
          amount,
          paid_at: paidAt,
          reference,
          registered_by: uid
        }
      })
      await syncMerchandisePaymentStatus(id, uid, tx)
      return tx.incomingMerchandise.findUnique({
        where: { id },
        include: incomingDetailInclude
      })
    }, PAYMENT_TX_OPTIONS)

    if (!updated) {
      return res.status(404).json({ message: 'Registro de mercancía no encontrado' })
    }
    res.json(shapeIncomingDetail(updated))
  } catch (e) {
    if (e.message === 'EXCEEDS') {
      return res.status(400).json({ message: 'El abono excede el saldo pendiente del ingreso' })
    }
    next(e)
  }
}

/**
 * Eliminar un abono (corrección)
 * DELETE /api/incoming-merchandise/:id/payments/:entryId
 */
exports.deletePaymentEntry = async (req, res, next) => {
  try {
    const { id, entryId } = req.params
    const uid = req.user?.sub
    if (!uid) {
      return res.status(401).json({ message: 'Usuario no autenticado' })
    }

    const updated = await prisma.$transaction(async (tx) => {
      const entry = await tx.incomingMerchandisePaymentEntry.findFirst({
        where: { id: entryId, incoming_merchandise_id: id }
      })
      if (!entry) {
        return null
      }
      await tx.incomingMerchandisePaymentEntry.delete({ where: { id: entryId } })
      await syncMerchandisePaymentStatus(id, uid, tx)
      return tx.incomingMerchandise.findUnique({
        where: { id },
        include: incomingDetailInclude
      })
    }, PAYMENT_TX_OPTIONS)

    if (!updated) {
      return res.status(404).json({ message: 'Abono no encontrado' })
    }
    res.json(shapeIncomingDetail(updated))
  } catch (e) {
    next(e)
  }
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

    const totalItems = await prisma.incomingMerchandise.count({ where })
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
      orderBy: { date: 'desc' },
      skip: (safePage - 1) * pageSize,
      take: pageSize,
    })

    // Calculate total value for each record
    const adapted = records.map(record => {
      const totalValue = record.items.reduce((sum, item) => {
        return sum + (Number(item.quantity) * Number(item.unit_cost))
      }, 0)

      return {
        id: record.id,
        supplier: {
          id: record.supplier.id,
          name: record.supplier.name,
          contact: record.supplier.contact
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
        items: record.items.map(item => ({
          id: item.id,
          product: {
            id: item.product.id,
            name: item.product.name,
            brand: item.product.brand,
            size: item.product.size,
            barcode: item.product.barcode
          },
          quantity: item.quantity,
          unit_cost: item.unit_cost,
          subtotal: Number(item.quantity) * Number(item.unit_cost)
        }))
      }
    })

    const nextPage = safePage < totalPages ? safePage + 1 : null
    const prevPage = safePage > 1 ? safePage - 1 : null

    res.json({
      items: adapted,
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
      where: { id, branch: { company_id: req.companyId } },
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
exports.updatePayment = async (req, res, next) => {
  try {
    const { id } = req.params
    const body = req.body || {}

    const existing = await prisma.incomingMerchandise.findFirst({
      where: { id, branch: { company_id: req.companyId } },
      include: {
        supplier: {
          include: {
            supplier_payment_terms: true
          }
        },
        items: true,
        paymentEntries: true
      }
    })

    if (!existing) {
      return res.status(404).json({ message: 'Registro de mercancía no encontrado' })
    }

    const merchandiseTotal = computeMerchandiseTotal(existing.items)
    const sumPaidExisting = (existing.paymentEntries || []).reduce(
      (s, e) => s + Number(e.amount),
      0
    )

    const hasKeys =
      body.payment_status !== undefined ||
      body.payment_term_id !== undefined ||
      body.paid_at !== undefined ||
      body.payment_reference !== undefined ||
      body.due_date !== undefined

    if (!hasKeys) {
      return res.status(400).json({ message: 'No hay campos para actualizar' })
    }

    if (body.payment_status !== undefined && (existing.paymentEntries || []).length > 0) {
      if (body.payment_status === 'PENDING' && sumPaidExisting > ROUND_EPS) {
        return res.status(400).json({
          message: 'Hay abonos registrados; elimínalos antes de volver a pendiente de pago'
        })
      }
      if (body.payment_status === 'PAID' && sumPaidExisting < merchandiseTotal - ROUND_EPS) {
        return res.status(400).json({
          message:
            'Los abonos aún no cubren el total del ingreso; registra abonos hasta completar el saldo o revisa los montos'
        })
      }
    }

    const data = {}
    const allowedTerms = new Set(
      (existing.supplier.supplier_payment_terms || []).map((l) => l.payment_term_id)
    )

    if (body.payment_status !== undefined) {
      if (!['PENDING', 'PARTIAL', 'PAID'].includes(body.payment_status)) {
        return res.status(400).json({ message: 'payment_status inválido' })
      }
      data.payment_status = body.payment_status
    }

    if (body.payment_term_id !== undefined) {
      if (body.payment_term_id === null || body.payment_term_id === '') {
        if (allowedTerms.size > 0) {
          return res.status(400).json({ message: 'Este proveedor requiere un término de pago' })
        }
        data.payment_term_id = null
      } else {
        const pid = Number(body.payment_term_id)
        if (!Number.isFinite(pid)) {
          return res.status(400).json({ message: 'payment_term_id inválido' })
        }
        if (allowedTerms.size > 0 && !allowedTerms.has(pid)) {
          return res.status(400).json({ message: 'El término no está asignado a este proveedor' })
        }
        if (allowedTerms.size === 0) {
          return res.status(400).json({ message: 'Este proveedor no tiene términos de pago en catálogo' })
        }
        data.payment_term_id = pid
      }
    }

    if (body.payment_reference !== undefined) {
      let ref = String(body.payment_reference || '').trim()
      if (ref.length > 255) ref = ref.slice(0, 255)
      data.payment_reference = ref || null
    }

    if (body.due_date !== undefined) {
      if (body.due_date === null || body.due_date === '') {
        data.due_date = null
      } else {
        const d = new Date(body.due_date)
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ message: 'due_date inválida' })
        }
        data.due_date = d
      }
    }

    if (body.paid_at !== undefined) {
      if (body.paid_at === null || body.paid_at === '') {
        data.paid_at = null
      } else {
        const p = new Date(body.paid_at)
        if (Number.isNaN(p.getTime())) {
          return res.status(400).json({ message: 'paid_at inválido' })
        }
        data.paid_at = p
      }
    }

    const nextStatus = data.payment_status !== undefined ? data.payment_status : existing.payment_status

    if (nextStatus === 'PENDING' || nextStatus === 'PARTIAL') {
      data.paid_at = null
    } else if (nextStatus === 'PAID') {
      const resolvedPaid = data.paid_at !== undefined ? data.paid_at : existing.paid_at
      if (!resolvedPaid) {
        data.paid_at = new Date()
      }
    }

    const uid = req.user?.sub
    if (!uid) {
      return res.status(401).json({ message: 'Usuario no autenticado' })
    }
    data.payment_updated_by = uid
    data.payment_updated_at = new Date()

    const updated = await prisma.incomingMerchandise.update({
      where: { id },
      data,
      include: incomingDetailInclude
    })

    res.json(shapeIncomingDetail(updated))
  } catch (e) {
    next(e)
  }
}

/**
 * Generate PDF report for incoming merchandise
 * GET /api/incoming-merchandise/report
 */
exports.generateReport = async (req, res, next) => {
  try {
    const { supplier_id, start_date, end_date, payment_status } = req.query || {}

    const where = {}

    if (supplier_id) {
      where.supplier_id = String(supplier_id)
    }

    if (payment_status === 'PENDING' || payment_status === 'PAID' || payment_status === 'PARTIAL') {
      where.payment_status = payment_status
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

    // Generate PDF
    const doc = new PDFDocument({ margin: 50 })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename="reporte-mercancia.pdf"')
    doc.pipe(res)

    const branding = await getBrandingForPdf(prisma, req.companyId)
    const companyName = branding.company_name
    if (branding.logoBuffer) {
      try {
        const pageWidth = doc.page.width
        doc.image(branding.logoBuffer, pageWidth / 2 - 22, doc.y, { fit: [44, 26] })
        doc.moveDown(2)
      } catch {
        /* sin logo */
      }
    }
    doc.fontSize(12).text(companyName, { align: 'center' })
    doc.moveDown(0.3)
    doc.fontSize(20).text('Reporte de Ingresos de Mercancía', { align: 'center' })
    doc.moveDown()
    
    if (start_date || end_date) {
      doc.fontSize(12).text(
        `Período: ${start_date ? new Date(start_date).toLocaleDateString('es-GT') : 'Inicio'} - ${end_date ? new Date(end_date).toLocaleDateString('es-GT') : 'Fin'}`,
        { align: 'center' }
      )
      doc.moveDown()
    }

    if (payment_status === 'PENDING' || payment_status === 'PAID' || payment_status === 'PARTIAL') {
      const payPdf =
        payment_status === 'PAID' ? 'Pagado' : payment_status === 'PARTIAL' ? 'Pago parcial' : 'Pendiente'
      doc.fontSize(11).text(`Estado de pago: ${payPdf}`, { align: 'center' })
      doc.moveDown(0.5)
    }

    doc.fontSize(10)

    let yPosition = doc.y
    let totalGeneral = 0

    records.forEach((record, index) => {
      // Check if we need a new page
      if (yPosition > 700) {
        doc.addPage()
        yPosition = 50
      }

      const recordTotal = record.items.reduce((sum, item) => {
        return sum + (Number(item.quantity) * Number(item.unit_cost))
      }, 0)
      totalGeneral += recordTotal

      // Record header
      doc.fontSize(12).font('Helvetica-Bold')
        .text(`Registro #${index + 1}`, 50, yPosition)
      yPosition += 20

      doc.fontSize(10).font('Helvetica')
        .text(`Fecha: ${new Date(record.date).toLocaleDateString('es-GT')}`, 50, yPosition)
      yPosition += 15

      doc.text(`Proveedor: ${record.supplier.name}`, 50, yPosition)
      yPosition += 15

      doc.text(`Registrado por: ${record.registeredBy.name}`, 50, yPosition)
      yPosition += 15

      const termName = record.paymentTerm?.name || '—'
      doc.text(`Término de pago: ${termName}`, 50, yPosition)
      yPosition += 15

      const payLabel =
        record.payment_status === 'PAID'
          ? 'Pagado'
          : record.payment_status === 'PARTIAL'
            ? 'Pago parcial'
            : 'Pendiente de pago'
      doc.text(`Estado: ${payLabel}`, 50, yPosition)
      yPosition += 15

      if (record.paid_at) {
        doc.text(
          `Fecha de pago: ${new Date(record.paid_at).toLocaleString('es-GT')}`,
          50,
          yPosition
        )
        yPosition += 15
      }
      if (record.due_date) {
        doc.text(
          `Vencimiento: ${new Date(record.due_date).toLocaleDateString('es-GT')}`,
          50,
          yPosition
        )
        yPosition += 15
      }
      if (record.payment_reference) {
        doc.text(`Referencia: ${record.payment_reference}`, 50, yPosition)
        yPosition += 15
      }

      if (record.notes) {
        doc.text(`Notas: ${record.notes}`, 50, yPosition)
        yPosition += 15
      }

      // Items table
      doc.font('Helvetica-Bold')
        .text('Productos:', 50, yPosition)
      yPosition += 20

      doc.font('Helvetica')
      record.items.forEach(item => {
        const productName = `${item.product.name} ${item.product.brand || ''} ${item.product.size || ''}`.trim()
        const subtotal = Number(item.quantity) * Number(item.unit_cost)
        doc.text(
          `  • ${productName}: ${item.quantity} x Q${Number(item.unit_cost).toFixed(2)} = Q${subtotal.toFixed(2)}`,
          50,
          yPosition
        )
        yPosition += 15
      })

      doc.font('Helvetica-Bold')
        .text(`Total del registro: Q${recordTotal.toFixed(2)}`, 50, yPosition)
      yPosition += 25

      doc.moveTo(50, yPosition).lineTo(550, yPosition).stroke()
      yPosition += 15
    })

    // Total general
    doc.fontSize(14).font('Helvetica-Bold')
      .text(`Total General: Q${totalGeneral.toFixed(2)}`, 50, yPosition, { align: 'right' })

    doc.end()
  } catch (e) {
    next(e)
  }
}
