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
const {
  uploadImageBuffer,
  removePublicObject,
  CATEGORY_IMAGES_BUCKET,
} = require('../../services/supabaseStorage')

function parseOptionalImageUrl(raw) {
  if (raw === undefined) return { provided: false, value: undefined }
  if (raw === null || raw === '') return { provided: true, value: null }
  if (typeof raw !== 'string') {
    const err = new Error('image_url inválido')
    err.status = 400
    throw err
  }
  const trimmed = raw.trim()
  return { provided: true, value: trimmed || null }
}

/**
 * @swagger
 * /api/product-categories:
 *   get:
 *     summary: Listar categorías de productos
 *     description: Obtiene todas las categorías activas (no eliminadas)
 *     tags: [Catálogos]
 *     parameters:
 *       - in: query
 *         name: includeDeleted
 *         schema:
 *           type: boolean
 *         description: Incluir categorías eliminadas
 *     responses:
 *       200:
 *         description: Lista de categorías
 */
exports.list = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page ?? 1))
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)))
    const { includeDeleted } = req.query
    const where = includeDeleted === 'true' ? {} : { deleted: false }
    where.company_id = req.companyId
    
    const totalItems = await prisma.productCategory.count({ where })
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    const safePage = Math.min(page, totalPages)
    
    const categories = await prisma.productCategory.findMany({ 
      where,
      orderBy: { name: 'asc' },
      include: { 
        _count: { 
          select: { 
            products: { where: { deleted: false } }, 
            // suppliers ahora es una relación a SupplierCategory (tabla intermedia)
            // contamos solo las relaciones cuyo proveedor no esté eliminado
            suppliers: { 
              where: { 
                supplier: { deleted: false }
              } 
            } 
          } 
        } 
      },
      skip: (safePage - 1) * pageSize,
      take: pageSize,
    })
    
    const nextPage = safePage < totalPages ? safePage + 1 : null
    const prevPage = safePage > 1 ? safePage - 1 : null
    
    res.json({
      items: categories,
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
 * /api/product-categories:
 *   post:
 *     summary: Crear categoría de producto
 *     description: Crea una nueva categoría de producto
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
 *                 example: "Licores"
 *     responses:
 *       201:
 *         description: Categoría creada
 *       400:
 *         description: Datos inválidos
 *       409:
 *         description: Categoría ya existe
 */
exports.create = async (req, res, next) => {
  try {
    const { name, image_url: rawImageUrl } = req.body
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'El nombre es requerido' })
    }

    const imageParsed = parseOptionalImageUrl(rawImageUrl)
    const data = { name: name.trim(), company_id: req.companyId }
    if (imageParsed.provided && imageParsed.value) {
      data.image_url = imageParsed.value
    }

    const created = await prisma.productCategory.create({ data })
    res.status(201).json(created)
  } catch (e) {
    if (e.status) {
      return res.status(e.status).json({ message: e.message })
    }
    if (e.code === 'P2002') {
      return res.status(409).json({ message: 'Ya existe una categoría con ese nombre' })
    }
    next(e)
  }
}

/**
 * @swagger
 * /api/product-categories/{id}:
 *   put:
 *     summary: Actualizar categoría de producto
 *     description: Actualiza una categoría existente
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
 *         description: Categoría actualizada
 *       404:
 *         description: Categoría no encontrada
 *       409:
 *         description: Nombre duplicado
 */
exports.update = async (req, res, next) => {
  try {
    const { id } = req.params
    const { name, image_url: rawImageUrl } = req.body
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'El nombre es requerido' })
    }

    const categoryId = Number(id)
    const existing = await prisma.productCategory.findFirst({ where: { id: categoryId, company_id: req.companyId } })
    if (!existing) {
      return res.status(404).json({ message: 'Categoría no encontrada' })
    }

    const imageParsed = parseOptionalImageUrl(rawImageUrl)
    const data = { name: name.trim() }
    if (imageParsed.provided) {
      data.image_url = imageParsed.value
      if (existing.image_url && existing.image_url !== imageParsed.value) {
        await removePublicObject(existing.image_url, CATEGORY_IMAGES_BUCKET)
      }
    }

    const updated = await prisma.productCategory.update({
      where: { id: categoryId },
      data,
    })
    res.json(updated)
  } catch (e) {
    if (e.status) {
      return res.status(e.status).json({ message: e.message })
    }
    if (e.code === 'P2025') {
      return res.status(404).json({ message: 'Categoría no encontrada' })
    }
    if (e.code === 'P2002') {
      return res.status(409).json({ message: 'Ya existe una categoría con ese nombre' })
    }
    next(e)
  }
}

/**
 * @swagger
 * /api/product-categories/{id}:
 *   delete:
 *     summary: Eliminar categoría (soft delete)
 *     description: Marca una categoría como eliminada si no tiene productos ni proveedores vinculados
 *     tags: [Catálogos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Categoría eliminada
 *       400:
 *         description: Tiene productos o proveedores vinculados
 *       404:
 *         description: Categoría no encontrada
 */
exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params
    
    // Verificar productos y proveedores vinculados activos
    const linkedProducts = await prisma.product.count({ 
      where: { category_id: Number(id), deleted: false }
    })
    const linkedSuppliers = await prisma.supplierCategory.count({ 
      where: { 
        category_id: Number(id),
        supplier: { deleted: false }
      }
    })
    
    if (linkedProducts > 0 || linkedSuppliers > 0) {
      return res.status(400).json({ 
        message: `No se puede eliminar. Tiene ${linkedProducts} producto(s) y ${linkedSuppliers} proveedor(es) vinculado(s)` 
      })
    }
    
    const owned = await prisma.productCategory.findFirst({
      where: { id: Number(id), company_id: req.companyId },
      select: { id: true },
    })
    if (!owned) return res.status(404).json({ message: 'Categoría no encontrada' })

    // Soft delete
    const deleted = await prisma.productCategory.update({
      where: { id: Number(id) },
      data: { deleted: true }
    })
    
    res.json({ ok: true, deleted })
  } catch (e) {
    if (e.code === 'P2025') {
      return res.status(404).json({ message: 'Categoría no encontrada' })
    }
    next(e)
  }
}

/**
 * @swagger
 * /api/product-categories/{id}/restore:
 *   patch:
 *     summary: Restaurar categoría eliminada
 *     description: Restaura una categoría que fue eliminada
 *     tags: [Catálogos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Categoría restaurada
 *       404:
 *         description: Categoría no encontrada
 */
exports.restore = async (req, res, next) => {
  try {
    const { id } = req.params
    const owned = await prisma.productCategory.findFirst({
      where: { id: Number(id), company_id: req.companyId },
      select: { id: true },
    })
    if (!owned) return res.status(404).json({ message: 'Categoría no encontrada' })
    const restored = await prisma.productCategory.update({
      where: { id: Number(id) },
      data: { deleted: false }
    })
    res.json({ ok: true, restored })
  } catch (e) {
    if (e.code === 'P2025') {
      return res.status(404).json({ message: 'Categoría no encontrada' })
    }
    next(e)
  }
}

/**
 * @swagger
 * /api/catalogs/product-categories/template:
 *   get:
 *     summary: Descargar plantilla Excel para importación de categorías
 *     description: Genera un archivo Excel con la estructura para importar categorías masivamente
 *     tags: [Catálogos]
 *     produces:
 *       - application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
 *     responses:
 *       200:
 *         description: Archivo Excel
 */
exports.downloadTemplate = async (req, res, next) => {
  try {
    const buffer = generateCatalogTemplate('categories')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_categorias.xlsx"')
    res.send(buffer)
  } catch (e) {
    next(e)
  }
}

/**
 * @swagger
 * /api/catalogs/product-categories/validate-import-mapped:
 *   post:
 *     summary: Validar categorías sin importar
 *     description: Valida categorías desde JSON y retorna errores sin crear registros
 *     tags: [Catálogos]
 *     security:
 *       - bearerAuth: []
 */
exports.validateImportMapped = async (req, res, next) => {
  try {
    const { items } = req.body || {}

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'No se proporcionaron categorías para validar' })
    }

    // Validate without importing
    const validation = await bulkValidateCatalogs(items, 'categories', req.companyId)

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
 * /api/catalogs/product-categories/bulk-import-mapped:
 *   post:
 *     summary: Importar categorías con campos mapeados
 *     description: Importa categorías desde JSON con campos ya mapeados por el frontend
 *     tags: [Catálogos]
 *     security:
 *       - bearerAuth: []
 */
exports.bulkImportMapped = async (req, res, next) => {
  try {
    const { items } = req.body || {}

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'No se proporcionaron categorías para importar' })
    }

    // Validate all categories
    const validation = await bulkValidateCatalogs(items, 'categories', req.companyId)

    if (validation.invalidRows.length > 0) {
      return res.status(400).json({
        message: `${validation.invalidRows.length} categorías tienen errores`,
        ...validation
      })
    }

    // All valid, proceed to import
    const result = await bulkCreateCatalogs(validation.validRows, 'categories', req.companyId)

    res.json({
      ok: true,
      created: result.created,
      skipped: result.skipped || 0,
      errors: result.errors || [],
      message: result.skipped > 0
        ? `Se importaron ${result.created} categorías (${result.skipped} omitidas por duplicados)`
        : `Se importaron ${result.created} categorías exitosamente`
    })
  } catch (e) {
    next(e)
  }
}

/**
 * POST /api/catalogs/product-categories/upload-image
 * Sube imagen representativa al bucket Supabase "categorias".
 * multipart/form-data, campo "image". Retorna { imageUrl }.
 */
exports.uploadImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No se proporcionó ningún archivo' })
    }

    const imageUrl = await uploadImageBuffer({
      bucket: CATEGORY_IMAGES_BUCKET,
      file: req.file,
    })

    res.json({ imageUrl })
  } catch (e) {
    if (e.status) {
      return res.status(e.status).json({ message: e.message })
    }
    next(e)
  }
}
