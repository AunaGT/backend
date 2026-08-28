/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * Métodos de pago (ventas, cierre de caja).
 */

const { prisma } = require('../models/prisma')

/** Mismos valores que prisma/seed.js — si la BD nunca se sembró, el listado no puede quedar vacío. */
const DEFAULT_PAYMENT_METHODS = [
  { name: 'Efectivo', is_credit: false },
  { name: 'Tarjeta', is_credit: false },
  { name: 'Transferencia', is_credit: false },
  { name: 'Crédito', is_credit: true },
]

const MAX_NAME_LEN = 50

async function ensureDefaultPaymentMethods() {
  let paymentMethods = await prisma.paymentMethod.findMany({ orderBy: { id: 'asc' } })
  if (paymentMethods.length === 0) {
    await prisma.paymentMethod.createMany({
      data: DEFAULT_PAYMENT_METHODS,
      skipDuplicates: true,
    })
    paymentMethods = await prisma.paymentMethod.findMany({ orderBy: { id: 'asc' } })
  }
  return paymentMethods
}

const methodIncludeCounts = {
  _count: {
    select: {
      sales: true,
      cash_closure_payments: true,
    },
  },
}

/** GET — sin paginación (compatibilidad POS / selects). */
exports.list = async (req, res, next) => {
  try {
    const hasAdminQuery =
      req.query.page != null || req.query.pageSize != null || String(req.query.search || '').trim()

    if (!hasAdminQuery) {
      const paymentMethods = await ensureDefaultPaymentMethods()
      return res.json(paymentMethods)
    }

    const page = Math.max(1, Number(req.query.page ?? 1))
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)))
    const search = String(req.query.search || '').trim()

    await ensureDefaultPaymentMethods()

    const where = search
      ? { name: { contains: search, mode: 'insensitive' } }
      : {}

    const totalItems = await prisma.paymentMethod.count({ where })
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    const safePage = Math.min(page, totalPages)

    const items = await prisma.paymentMethod.findMany({
      where,
      orderBy: { name: 'asc' },
      include: methodIncludeCounts,
      skip: (safePage - 1) * pageSize,
      take: pageSize,
    })

    res.json({
      items,
      page: safePage,
      pageSize,
      totalPages,
      totalItems,
      nextPage: safePage < totalPages ? safePage + 1 : null,
      prevPage: safePage > 1 ? safePage - 1 : null,
    })
  } catch (error) {
    next(error)
  }
}

exports.create = async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim()
    if (!name) {
      return res.status(400).json({ message: 'El nombre es requerido' })
    }
    if (name.length > MAX_NAME_LEN) {
      return res.status(400).json({ message: `El nombre no puede superar ${MAX_NAME_LEN} caracteres` })
    }

    const created = await prisma.paymentMethod.create({
      data: { name },
      include: methodIncludeCounts,
    })
    res.status(201).json(created)
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ message: 'Ya existe un método de pago con ese nombre' })
    }
    next(e)
  }
}

exports.update = async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) {
      return res.status(400).json({ message: 'ID inválido' })
    }
    const name = String(req.body?.name || '').trim()
    if (!name) {
      return res.status(400).json({ message: 'El nombre es requerido' })
    }
    if (name.length > MAX_NAME_LEN) {
      return res.status(400).json({ message: `El nombre no puede superar ${MAX_NAME_LEN} caracteres` })
    }

    const updated = await prisma.paymentMethod.update({
      where: { id },
      data: { name },
      include: methodIncludeCounts,
    })
    res.json(updated)
  } catch (e) {
    if (e.code === 'P2025') {
      return res.status(404).json({ message: 'Método de pago no encontrado' })
    }
    if (e.code === 'P2002') {
      return res.status(409).json({ message: 'Ya existe un método de pago con ese nombre' })
    }
    next(e)
  }
}

exports.remove = async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) {
      return res.status(400).json({ message: 'ID inválido' })
    }

    const existing = await prisma.paymentMethod.findUnique({
      where: { id },
      include: methodIncludeCounts,
    })
    if (!existing) {
      return res.status(404).json({ message: 'Método de pago no encontrado' })
    }

    const total = await prisma.paymentMethod.count()
    if (total <= 1) {
      return res.status(400).json({ message: 'Debe existir al menos un método de pago en el sistema' })
    }

    const salesCount = existing._count?.sales ?? 0
    const closureCount = existing._count?.cash_closure_payments ?? 0
    if (salesCount > 0 || closureCount > 0) {
      const parts = []
      if (salesCount > 0) parts.push(`${salesCount} venta(s)`)
      if (closureCount > 0) parts.push(`${closureCount} línea(s) de cierre de caja`)
      return res.status(400).json({
        message: `No se puede eliminar: está en uso (${parts.join(', ')}).`,
      })
    }

    await prisma.paymentMethod.delete({ where: { id } })
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
}
