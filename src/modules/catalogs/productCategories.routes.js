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
const ctrl = require('./productCategories.controller')
const router = Router()

const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true)
    } else {
      cb(new Error('Solo se permiten archivos de imagen'))
    }
  },
})

/**
 * @openapi
 * tags:
 *   - name: ProductCategories
 *     description: Gestión de categorías de productos
 */

/**
 * @openapi
 * /catalogs/product-categories:
 *   get:
 *     tags: [ProductCategories]
 *     summary: Listar categorías de productos
 *     responses:
 *       200:
 *         description: Lista de categorías
 */
router.get('/', Auth, ctrl.list)

/**
 * @openapi
 * /catalogs/product-categories/template:
 *   get:
 *     tags: [ProductCategories]
 *     summary: Descargar plantilla Excel para importación de categorías
 *     description: Genera archivo Excel con estructura para importar categorías
 *     responses:
 *       200:
 *         description: Archivo Excel
 *         content:
 *           application/vnd.openxmlformats-officedocument.spreadsheetml.sheet:
 *             schema:
 *               type: string
 *               format: binary
 */
router.get('/template', Auth, hasPermission('catalogs.manage'), ctrl.downloadTemplate)

/**
 * @openapi
 * /catalogs/product-categories/validate-import-mapped:
 *   post:
 *     tags: [ProductCategories]
 *     summary: Validar categorías sin importar
 *     description: Valida categorías desde JSON y retorna errores sin crear registros
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               items:
 *                 type: array
 *     responses:
 *       200:
 *         description: Resultado de validación
 */
router.post('/validate-import-mapped', Auth, hasPermission('catalogs.manage'), ctrl.validateImportMapped)

/**
 * @openapi
 * /catalogs/product-categories/bulk-import-mapped:
 *   post:
 *     tags: [ProductCategories]
 *     summary: Importar categorías con campos mapeados
 *     description: Importa categorías desde JSON con campos ya mapeados por el frontend
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               items:
 *                 type: array
 *     responses:
 *       200:
 *         description: Resultado de importación
 *       400:
 *         description: Error de validación
 */
router.post('/bulk-import-mapped', Auth, hasPermission('catalogs.manage'), ctrl.bulkImportMapped)

/**
 * @openapi
 * /catalogs/product-categories/upload-image:
 *   post:
 *     tags: [ProductCategories]
 *     summary: Subir imagen representativa de categoría
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               image:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: URL pública de la imagen
 */
router.post(
  '/upload-image',
  Auth,
  hasPermission('catalogs.manage'),
  uploadImage.single('image'),
  ctrl.uploadImage
)

/**
 * @openapi
 * /catalogs/product-categories:
 *   post:
 *     tags: [ProductCategories]
 *     summary: Crear una nueva categoría
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *     responses:
 *       201:
 *         description: Creada
 */
router.post('/', Auth, hasPermission('catalogs.manage'), ctrl.create)

/**
 * @openapi
 * /catalogs/product-categories/{id}:
 *   put:
 *     tags: [ProductCategories]
 *     summary: Actualizar categoría
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
 *             properties:
 *               name:
 *                 type: string
 *     responses:
 *       200:
 *         description: Actualizada
 */
router.put('/:id', Auth, hasPermission('catalogs.manage'), ctrl.update)

/**
 * @openapi
 * /catalogs/product-categories/{id}:
 *   delete:
 *     tags: [ProductCategories]
 *     summary: Eliminar categoría (soft delete)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Eliminada
 */
router.delete('/:id', Auth, hasPermission('catalogs.manage'), ctrl.remove)

/**
 * @openapi
 * /catalogs/product-categories/{id}/restore:
 *   patch:
 *     tags: [ProductCategories]
 *     summary: Restaurar categoría eliminada
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Restaurada
 */
router.patch('/:id/restore', Auth, hasPermission('catalogs.manage'), ctrl.restore)

module.exports = router
