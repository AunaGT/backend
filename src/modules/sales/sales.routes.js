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
const { Auth, hasAnyRole, hasPermission } = require('../../middlewares/autenticacion')
const Sales = require('./controller')
const { requirePromotionsForSale } = require('./middleware')

const router = Router()

/**
 * @openapi
 * tags:
 *   - name: Sales
 *     description: Gestión de ventas
 * components:
 *   schemas:
 *     SaleItemInput:
 *       type: object
 *       required: [product_id, price, qty]
 *       properties:
 *         product_id: { type: string, format: uuid }
 *         price: { type: number, format: float }
 *         qty: { type: integer }
 *     Sale:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid }
 *         date: { type: string, format: date-time }
 *         sold_at: { type: string, format: date-time }
 *         customer: { type: string }
 *         customer_nit: { type: string }
 *         is_final_consumer: { type: boolean }
 *         total: { type: number, format: float }
 *         items: { type: integer }
 *         payment_method_id: { type: integer }
 *         status_id: { type: integer }
 */

/**
 * @openapi
 * /sales:
 *   get:
 *     tags: [Sales]
 *     summary: Listar ventas (con filtros por periodo y paginación)
 *     parameters:
 *       - in: query
 *         name: period
 *         schema: { type: string, enum: ["today","week","month","year"] }
 *         description: Filtrar ventas por periodo relativo en hora local GT
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: 'Filtrar por estado de la venta (por ejemplo: "pendiente", "pagado"). Si se pasa, la consulta devolverá sólo ventas con ese estado.'
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *         description: Página (1-based)
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 100 }
 *         description: Tamaño de página (max 1000)
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Sale'
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *                 totalPages: { type: integer }
 *                 totalItems: { type: integer }
 *                 nextPage: { type: integer, nullable: true }
 */
router.get('/', Auth, hasPermission('sales.view'), Sales.list)

/**
 * @openapi
 * /sales/{id}:
 *   get:
 *     tags: [Sales]
 *     summary: Obtener venta por ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Venta encontrada
 *       404:
 *         description: Venta no encontrada
 */
router.get('/:id', Auth, hasPermission('sales.view', 'sales.view_detail', 'sales.view_invoice', 'returns.manage'), Sales.getById)

/**
 * @openapi
 * /sales:
 *   post:
 *     tags: [Sales]
 *     summary: Crear venta
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [items, payment_method_id, status_id]
 *             properties:
 *               customer: { type: string }
 *               customer_nit: { type: string }
 *               is_final_consumer: { type: boolean }
 *               payment_method_id: { type: integer }
 *               status_id: { type: integer }
 *               items:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/SaleItemInput'
 *     responses:
 *       201: { description: Creado }
 */
router.post('/', Auth, hasPermission('sales.create'), requirePromotionsForSale, Sales.create)

/**
 * @openapi
 * /sales/{id}/status:
 *   patch:
 *     tags: [Sales]
 *     summary: Actualizar estado de una venta
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status_id: { type: integer, description: ID directo del estado }
 *               status_name: { type: string, description: Nombre del estado (alternativo a status_id) }
 *             oneOf:
 *               - required: [status_id]
 *               - required: [status_name]
 *     responses:
 *       200: { description: Estado actualizado }
 *       400: { description: Petición inválida }
 *       404: { description: Venta no encontrada }
 */
router.patch('/:id/status', Auth, hasPermission('sales.cancel', 'sales.create'), Sales.updateStatus)

module.exports = router
