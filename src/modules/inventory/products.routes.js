/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

const { Router } = require('express')
const multer = require('multer')
const { Auth, hasAnyRole, hasPermission } = require('../../middlewares/autenticacion')
const Products = require('./products.controller')

// Configure multer for memory storage (keep file in buffer)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const allowedMimes = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel',
            'text/csv'
        ]
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true)
        } else {
            cb(new Error('Tipo de archivo no permitido. Use Excel (.xlsx, .xls) o CSV.'))
        }
    }
})

// Configure multer for image uploads
const uploadImage = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true)
        } else {
            cb(new Error('Solo se permiten archivos de imagen'))
        }
    }
})

const router = Router()

/**
 * @openapi
 * tags:
 *   - name: Products
 *     description: Gestión de productos
 * components:
 *   schemas:
 *     Product:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid }
 *         name: { type: string }
 *         category_id: { type: integer }
 *         brand: { type: string }
 *         size: { type: string }
 *         stock: { type: integer }
 *         min_stock: { type: integer }
 *         price: { type: number, format: float }
 *         cost: { type: number, format: float }
 *         supplier_id: { type: string, format: uuid }
 *         barcode: { type: string }
 *         description: { type: string }
 *         status_id: { type: integer }
 */

/**
 * @openapi
 * /products:
 *   get:
 *     tags: [Products]
 *     summary: Listar productos
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Product'
 */
router.get('/', Auth, Products.list)

/**
 * @openapi
 * /products/critical:
 *   get:
 *     tags: [Products]
 *     summary: Listar productos críticos (stock por debajo del mínimo)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Product'
 */
router.get('/critical', Auth, hasPermission('products.view', 'alerts.view'), Products.critical)

/**
 * @openapi
 * /products/report.pdf:
 *   get:
 *     tags: [Products]
 *     summary: Reporte PDF de productos
 *     description: Genera un PDF profesional con el inventario actual.
 *     responses:
 *       200:
 *         description: PDF
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 */
router.get('/report.pdf', Auth, hasPermission('products.export', 'reports.view'), Products.reportPdf)

router.get('/availability', Auth, hasPermission('products.view', 'sales.create', 'orders.view', 'quotes.view'), Products.availability)

/**
 * GET /products/lots/expiring?days=30&status=expiring|expired|all
 * Lotes por vencer / vencidos (antes de /:id para no capturar "lots" como id)
 */
router.get('/lots/expiring', Auth, hasPermission('products.view'), Products.lotsExpiring)

/** Corregir / eliminar un lote mal ingresado (cantidad, caducidad, código). Reconcilia stock. */
// Dar de baja lo que quedó de un lote destruye existencias: mismo permiso que un ajuste.
router.post('/lots/write-off', Auth, hasPermission('stock_moves.adjust'), Products.writeOffLots)
router.patch('/lots/:lotId', Auth, hasPermission('products.register_incoming'), Products.updateLot)
router.delete('/lots/:lotId', Auth, hasPermission('products.register_incoming'), Products.deleteLot)

/**
 * @openapi
 * /products/import-template:
 *   get:
 *     tags: [Products]
 *     summary: Descargar plantilla de importación
 *     description: Genera archivo Excel con estructura para importar productos
 *     responses:
 *       200:
 *         description: Archivo Excel
 *         content:
 *           application/vnd.openxmlformats-officedocument.spreadsheetml.sheet:
 *             schema:
 *               type: string
 *               format: binary
 */
router.get('/import-template', Auth, hasPermission('products.import'), Products.getImportTemplate)

/**
 * @openapi
 * /products/validate-import:
 *   post:
 *     tags: [Products]
 *     summary: Validar archivo de importación
 *     description: Parsea y valida Excel antes de importar
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Resultado de validación
 */
router.post('/validate-import', Auth, hasPermission('products.import'), upload.single('file'), Products.validateImport)

/**
 * @openapi
 * /products/bulk-import:
 *   post:
 *     tags: [Products]
 *     summary: Importar productos masivamente
 *     description: Importa productos desde archivo Excel
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Resultado de importación
 *       400:
 *         description: Error de validación
 */
router.post('/bulk-import', Auth, hasPermission('products.import'), upload.single('file'), Products.bulkImport)

/**
 * @openapi
 * /products/bulk-import-mapped:
 *   post:
 *     tags: [Products]
 *     summary: Importar productos con campos mapeados
 *     description: Importa productos desde JSON con campos ya mapeados por el frontend
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               products:
 *                 type: array
 *     responses:
 *       200:
 *         description: Resultado de importación
 *       400:
 *         description: Error de validación
 */
router.post('/bulk-import-mapped', Auth, hasPermission('products.import'), Products.bulkImportMapped)

/**
 * @openapi
 * /products/validate-import-mapped:
 *   post:
 *     tags: [Products]
 *     summary: Validar productos sin importar
 *     description: Valida productos desde JSON y retorna errores sin crear registros
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               products:
 *                 type: array
 *     responses:
 *       200:
 *         description: Resultado de validación
 */
router.post('/validate-import-mapped', Auth, hasPermission('products.import'), Products.validateImportMapped)

/**
 * @openapi
 * /products:
 *   post:
 *     tags: [Products]
 *     summary: Crear producto
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Product'
 *     responses:
 *       201: { description: Creado }
 */
router.post('/', Auth, hasPermission('products.create'), Products.create)

router.post(
  '/pricing-preview',
  Auth,
  hasPermission('products.view', 'sales.create'),
  Products.pricingPreview
)

/**
 * @openapi
 * /products/{id}:
 *   get:
 *     tags: [Products]
 *     summary: Obtener producto por id
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: string }
 *         required: true
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Product'
 *       404: { description: No encontrado }
 */
// Lotes con existencia del producto (FEFO)
router.get('/:id/lots', Auth, hasPermission('products.view'), Products.getLots)
router.get('/:id/bom', Auth, Products.getBom)
router.put('/:id/bom', Auth, hasPermission('products.edit'), Products.updateBom)
router.post('/:id/kit/assemble', Auth, hasPermission('products.edit'), Products.assembleKit)
router.get('/:id', Auth, Products.getOne)

/**
 * @openapi
 * /products/{id}:
 *   put:
 *     tags: [Products]
 *     summary: Actualizar producto
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: string }
 *         required: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Product'
 *     responses:
 *       200: { description: OK }
 */
router.put('/:id', Auth, hasPermission('products.edit'), Products.update)

/**
 * @openapi
 * /products/{id}:
 *   delete:
 *     tags: [Products]
 *     summary: Eliminar producto
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: string }
 *         required: true
 *     responses:
 *       200: { description: OK }
 */
router.delete('/:id', Auth, hasPermission('products.delete'), Products.remove)

/**
 * @openapi
 * /products/{id}/branch-stock:
 *   delete:
 *     tags: [Products]
 *     summary: Quitar el producto de la sucursal activa (sigue existiendo en las demás)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: string }
 *         required: true
 *     responses:
 *       200: { description: OK }
 */
router.delete('/:id/branch-stock', Auth, hasPermission('products.delete'), Products.removeFromBranch)

/**
 * @openapi
 * /products/{id}/branch-stock:
 *   post:
 *     tags: [Products]
 *     summary: Empezar a manejar el producto en la sucursal activa (su stock arranca en 0)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: string }
 *         required: true
 *     responses:
 *       201: { description: Creado }
 */
router.post('/:id/branch-stock', Auth, hasPermission('products.edit', 'products.create'), Products.addToBranch)

/**
 * @openapi
 * /products/register-incoming:
 *   post:
 *     tags: [Products]
 *     summary: Registrar ingreso de mercancía desde un proveedor
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - supplier_id
 *               - items
 *             properties:
 *               supplier_id: { type: string, format: uuid }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required:
 *                     - product_id
 *                     - quantity
 *                     - unit_cost
 *                   properties:
 *                     product_id: { type: string, format: uuid }
 *                     quantity: { type: integer, minimum: 1 }
 *                     unit_cost: { type: number, minimum: 0 }
 *               notes: { type: string }
 *     responses:
 *       200: { description: OK }
 *       400: { description: Bad request }
 *       401: { description: Unauthorized }
 */
router.post('/register-incoming', Auth, hasPermission('products.register_incoming'), Products.registerIncomingMerchandise)

/**
 * @openapi
 * /products/{id}/restore:
 *   patch:
 *     tags: [Products]
 *     summary: Restaurar producto eliminado
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: OK }
 */
router.patch('/:id/restore', Auth, hasPermission('products.register_incoming', 'products.edit'), Products.restore)

/**
 * @openapi
 * /api/products/upload-image:
 *   post:
 *     summary: Sube una imagen de producto a Supabase Storage
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - image
 *             properties:
 *               image:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Imagen subida exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 imageUrl:
 *                   type: string
 *       400:
 *         description: Error en la petición
 *       500:
 *         description: Error del servidor
 */
router.post('/upload-image', Auth, hasPermission('products.create', 'products.edit'), uploadImage.single('image'), Products.uploadImage)

module.exports = router
