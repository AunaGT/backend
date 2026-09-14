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
const { generateCatalogTemplate } = require('../../services/catalogTemplate')
const { bulkValidateCatalogs, bulkCreateCatalogs } = require('../../services/catalogBulkImport')

/**
 * @swagger
 * /api/payment-terms:
 *   get:
 *     summary: Listar términos de pago
 *     description: Obtiene todos los términos de pago activos (no eliminados)
 *     tags: [Catálogos]
 *     parameters:
 *       - in: query
 *         name: includeDeleted
 *         schema:
 *           type: boolean
 *         description: Incluir términos eliminados
 *     responses:
 *       200:
 *         description: Lista de términos de pago
 */
exports.list = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page ?? 1))
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)))
    const { includeDeleted } = req.query
    const where = includeDeleted === 'true' ? {} : { deleted: false }
    where.company_id = req.companyId
    
    const totalItems = await prisma.paymentTerm.count({ where })
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    const safePage = Math.min(page, totalPages)
    
    const payment_terms = await prisma.paymentTerm.findMany({ 
      where,
      orderBy: { name: 'asc' },
      include: { _count: { select: { supplier_payment_terms: true } } },
      skip: (safePage - 1) * pageSize,
      take: pageSize,
    })
    
    const nextPage = safePage < totalPages ? safePage + 1 : null
    const prevPage = safePage > 1 ? safePage - 1 : null
    
    res.json({
      items: payment_terms,
      page: safePage,
      pageSize,
      totalPages,
      totalItems,
      nextPage,
      prevPage
    })
  } catch (e) { next(e) }
}

/**
 * @swagger
 * /api/payment-terms:
 *   post:
 *     summary: Crear término de pago
 *     description: Crea un nuevo término de pago
 *     tags: [Catálogos]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 example: "30 días"
 *     responses:
 *       201:
 *         description: Término de pago creado
 *       400:
 *         description: Datos inválidos
 *       409:
 *         description: Término ya existe
 */
exports.create = async (req, res, next) => {
  try {
    const { name, net_days } = req.body
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'El nombre es requerido' })
    }
    let netDaysVal = null
    if (net_days != null && net_days !== '') {
      const n = Number(net_days)
      if (!Number.isFinite(n) || n < 0 || n > 3650) {
        return res.status(400).json({ message: 'net_days debe ser un número entre 0 y 3650' })
      }
      netDaysVal = Math.floor(n)
    }
    const created = await prisma.paymentTerm.create({
      data: { name: name.trim(), net_days: netDaysVal, company_id: req.companyId },
    })
    res.status(201).json(created)
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ message: 'Ya existe un término de pago con ese nombre' })
    }
    next(e)
  }
}

/**
 * @swagger
 * /api/payment-terms/{id}:
 *   put:
 *     summary: Actualizar término de pago
 *     description: Actualiza un término de pago existente
 *     tags: [Catálogos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *     responses:
 *       200:
 *         description: Término actualizado
 *       404:
 *         description: Término no encontrado
 *       409:
 *         description: Nombre duplicado
 */
exports.update = async (req, res, next) => {
  try {
    const { id } = req.params
    const { name, net_days } = req.body
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'El nombre es requerido' })
    }
    const data = { name: name.trim() }
    if (net_days !== undefined) {
      if (net_days === null || net_days === '') {
        data.net_days = null
      } else {
        const n = Number(net_days)
        if (!Number.isFinite(n) || n < 0 || n > 3650) {
          return res.status(400).json({ message: 'net_days debe ser un número entre 0 y 3650' })
        }
        data.net_days = Math.floor(n)
      }
    }
    const owned = await prisma.paymentTerm.findFirst({
      where: { id: Number(id), company_id: req.companyId },
      select: { id: true },
    })
    if (!owned) return res.status(404).json({ message: 'Término de pago no encontrado' })
    const updated = await prisma.paymentTerm.update({
      where: { id: Number(id) },
      data,
    })
    res.json(updated)
  } catch (e) {
    if (e.code === 'P2025') {
      return res.status(404).json({ message: 'Término de pago no encontrado' })
    }
    if (e.code === 'P2002') {
      return res.status(409).json({ message: 'Ya existe un término con ese nombre' })
    }
    next(e)
  }
}

/**
 * @swagger
 * /api/payment-terms/{id}:
 *   delete:
 *     summary: Eliminar término de pago (soft delete)
 *     description: Marca un término de pago como eliminado si no tiene proveedores vinculados
 *     tags: [Catálogos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Término eliminado
 *       400:
 *         description: Tiene proveedores vinculados
 *       404:
 *         description: Término no encontrado
 */
exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params
    
    // Verificar proveedores vinculados
    const linkedSuppliers = await prisma.supplierPaymentTerm.count({
      where: { payment_term_id: Number(id), supplier: { deleted: false } },
    })
    
    if (linkedSuppliers > 0) {
      return res.status(400).json({ 
        message: `No se puede eliminar. Tiene ${linkedSuppliers} contacto(s) vinculado(s)` 
      })
    }
    
    const ownedForDelete = await prisma.paymentTerm.findFirst({
      where: { id: Number(id), company_id: req.companyId },
      select: { id: true },
    })
    if (!ownedForDelete) return res.status(404).json({ message: 'Término de pago no encontrado' })

    // Soft delete
    const deleted = await prisma.paymentTerm.update({
      where: { id: Number(id) },
      data: { deleted: true }
    })
    
    res.json({ ok: true, deleted })
  } catch (e) {
    if (e.code === 'P2025') {
      return res.status(404).json({ message: 'Término de pago no encontrado' })
    }
    next(e)
  }
}

/**
 * @swagger
 * /api/payment-terms/{id}/restore:
 *   patch:
 *     summary: Restaurar término de pago eliminado
 *     description: Restaura un término de pago que fue eliminado
 *     tags: [Catálogos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Término restaurado
 *       404:
 *         description: Término no encontrado
 */
exports.restore = async (req, res, next) => {
  try {
    const { id } = req.params
    const owned = await prisma.paymentTerm.findFirst({
      where: { id: Number(id), company_id: req.companyId },
      select: { id: true },
    })
    if (!owned) return res.status(404).json({ message: 'Término de pago no encontrado' })
    const restored = await prisma.paymentTerm.update({
      where: { id: Number(id) },
      data: { deleted: false }
    })
    res.json({ ok: true, restored })
  } catch (e) {
    if (e.code === 'P2025') {
      return res.status(404).json({ message: 'Término de pago no encontrado' })
    }
    next(e)
  }
}

/**
 * @swagger
 * /api/catalogs/payment-terms/template:
 *   get:
 *     summary: Descargar plantilla Excel para importación de términos de pago
 *     description: Genera un archivo Excel con la estructura para importar términos de pago masivamente
 *     tags: [Catálogos]
 *     produces:
 *       - application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
 *     responses:
 *       200:
 *         description: Archivo Excel
 */
exports.downloadTemplate = async (req, res, next) => {
  try {
    const buffer = generateCatalogTemplate('payment-terms')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_terminos_pago.xlsx"')
    res.send(buffer)
  } catch (e) {
    next(e)
  }
}

/**
 * @swagger
 * /api/catalogs/payment-terms/validate-import-mapped:
 *   post:
 *     summary: Validar términos de pago sin importar
 *     description: Valida términos de pago desde JSON y retorna errores sin crear registros
 *     tags: [Catálogos]
 *     security:
 *       - bearerAuth: []
 */
exports.validateImportMapped = async (req, res, next) => {
  try {
    const { items } = req.body || {}

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'No se proporcionaron términos de pago para validar' })
    }

    // Validate without importing
    const validation = await bulkValidateCatalogs(items, 'payment-terms', req.companyId)

    res.json({
      ok: true,
      totals: {
        total: items.length,
        valid: validation.validRows.length,
        invalid: validation.invalidRows.length
      },
      validRows: validation.validRows,
      invalidRows: validation.invalidRows
    })
  } catch (e) {
    next(e)
  }
}

/**
 * @swagger
 * /api/catalogs/payment-terms/bulk-import-mapped:
 *   post:
 *     summary: Importar términos de pago con campos mapeados
 *     description: Importa términos de pago desde JSON con campos ya mapeados por el frontend
 *     tags: [Catálogos]
 *     security:
 *       - bearerAuth: []
 */
exports.bulkImportMapped = async (req, res, next) => {
  try {
    const { items } = req.body || {}

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'No se proporcionaron términos de pago para importar' })
    }

    // Validate all payment terms
    const validation = await bulkValidateCatalogs(items, 'payment-terms', req.companyId)

    if (validation.invalidRows.length > 0) {
      return res.status(400).json({
        message: `${validation.invalidRows.length} términos de pago tienen errores`,
        ...validation
      })
    }

    // All valid, proceed to import
    const result = await bulkCreateCatalogs(validation.validRows, 'payment-terms', req.companyId)

    res.json({
      ok: true,
      created: result.created,
      skipped: result.skipped || 0,
      errors: result.errors || [],
      message: result.skipped > 0
        ? `Se importaron ${result.created} términos de pago (${result.skipped} omitidos por duplicados)`
        : `Se importaron ${result.created} términos de pago exitosamente`
    })
  } catch (e) {
    next(e)
  }
}
