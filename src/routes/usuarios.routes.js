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
const rateLimit = require('express-rate-limit')
const controller = require('../controllers/usuarios.controller')
const { Auth, hasAnyRole, hasPermission } = require('../middlewares/autenticacion')
const { requireModule } = require('../modules/platform')
const usersManifest = require('../modules/users/manifest')

const router = Router()
const usersModule = requireModule(usersManifest.code)

// Frena fuerza bruta en las rutas que verifican contraseña. 10 intentos / 15 min por IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiados intentos, probá de nuevo en unos minutos' },
})

// Configurar multer para almacenar en memoria
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
})

/**
 * @openapi
 * tags:
 *   - name: Auth
 *     description: Autenticación de usuarios
 */

/**
 * @openapi
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid }
 *         name: { type: string }
 *         email: { type: string, format: email }
 *         role_id: { type: integer }
 *     AuthResponse:
 *       type: object
 *       properties:
 *         user:
 *           $ref: '#/components/schemas/User'
 *         token:
 *           type: string
 */

/**
 * @openapi
 * /auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Registrar usuario
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password, role_id]
 *             properties:
 *               name: { type: string }
 *               email: { type: string, format: email }
 *               password: { type: string }
 *               role_id: { type: integer }
 *     responses:
 *       201:
 *         description: Creado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 */
router.post('/register', Auth, usersModule, hasPermission('users.create'), controller.register)

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Iniciar sesión
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 */
router.post('/login', loginLimiter, controller.login)
router.post('/refresh', controller.refresh)
router.post('/logout', controller.logout)

/**
 * @openapi
 * /auth/validate-admin:
 *   post:
 *     tags: [Auth]
 *     summary: Validar credenciales de administrador
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username: { type: string, description: Email del usuario }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Credenciales válidas
 *       401:
 *         description: Credenciales inválidas
 *       403:
 *         description: Usuario no es administrador
 */
router.post('/validate-admin', loginLimiter, controller.validateAdmin)

/**
 * @openapi
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Usuario autenticado
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 */
router.get('/me', Auth, controller.me)

/**
 * @openapi
 * /auth/users:
 *   get:
 *     tags: [Auth]
 *     summary: Listar usuarios (con roles)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 */
router.get('/users', Auth, usersModule, hasPermission('users.view'), controller.list)

/**
 * @openapi
 * /auth/users/template:
 *   get:
 *     tags: [Auth]
 *     summary: Descargar plantilla Excel para importar usuarios
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Archivo Excel descargado
 */
router.get('/users/template', Auth, usersModule, hasPermission('users.import'), controller.downloadTemplate)

/**
 * @openapi
 * /auth/users/validate-import-mapped:
 *   post:
 *     tags: [Auth]
 *     summary: Validar datos de usuarios mapeados para importación
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rows]
 *             properties:
 *               rows:
 *                 type: array
 *                 items:
 *                   type: object
 *     responses:
 *       200:
 *         description: Resultado de validación
 */
router.post('/users/validate-import-mapped', Auth, usersModule, hasPermission('users.import'), controller.validateImportMapped)

/**
 * @openapi
 * /auth/users/bulk-import-mapped:
 *   post:
 *     tags: [Auth]
 *     summary: Importar usuarios validados masivamente
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rows]
 *             properties:
 *               rows:
 *                 type: array
 *                 items:
 *                   type: object
 *     responses:
 *       200:
 *         description: Importación completada
 */
router.post('/users/bulk-import-mapped', Auth, usersModule, hasPermission('users.import'), controller.bulkImportMapped)

/**
 * @openapi
 * /auth/users/{id}:
 *   get:
 *     tags: [Auth]
 *     summary: Obtener un usuario específico
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: OK
 *       404:
 *         description: Usuario no encontrado
 */
router.get('/users/:id', Auth, usersModule, hasPermission('users.view'), controller.getById)

/**
 * @openapi
 * /auth/users/{id}:
 *   put:
 *     tags: [Auth]
 *     summary: Actualizar usuario (nombre, email, rol, contraseña)
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
 *               name: { type: string }
 *               email: { type: string, format: email }
 *               role_id: { type: integer }
 *               password: { type: string, description: "Nueva contraseña (opcional)" }
 *     responses:
 *       200:
 *         description: Usuario actualizado
 *       404:
 *         description: Usuario no encontrado
 *       409:
 *         description: Email ya en uso
 */
router.put('/users/:id', Auth, usersModule, hasPermission('users.edit'), controller.update)

/**
 * @openapi
 * /auth/users/{id}:
 *   delete:
 *     tags: [Auth]
 *     summary: Eliminar usuario
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Usuario eliminado
 *       400:
 *         description: No puedes eliminar tu propia cuenta
 *       404:
 *         description: Usuario no encontrado
 */
router.delete('/users/:id', Auth, usersModule, hasPermission('users.delete'), controller.delete)

/**
 * @openapi
 * /auth/roles:
 *   get:
 *     tags: [Auth]
 *     summary: Listar todos los roles disponibles
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de roles
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: integer }
 *                   name: { type: string }
 */
router.get('/roles', Auth, usersModule, hasPermission('roles.view', 'roles.manage'), controller.getRoles)

/**
 * @openapi
 * /auth/permissions:
 *   get:
 *     tags: [Auth]
 *     summary: Listar todos los permisos disponibles
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de permisos
 */
router.get('/permissions', Auth, usersModule, hasPermission('roles.manage', 'roles.view'), controller.getPermissions)

/**
 * @openapi
 * /auth/roles/with-permissions:
 *   get:
 *     tags: [Auth]
 *     summary: Listar roles con sus permisos asociados
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de roles con permisos
 */
router.get('/roles/with-permissions', Auth, usersModule, hasPermission('roles.manage', 'roles.view'), controller.getRolesWithPermissions)

/**
 * @openapi
 * /auth/roles/{id}/with-permissions:
 *   get:
 *     tags: [Auth]
 *     summary: Obtener un rol con sus permisos asociados
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Rol con permisos
 *       404:
 *         description: Rol no encontrado
 */
router.get('/roles/:id/with-permissions', Auth, usersModule, hasPermission('roles.manage', 'roles.view'), controller.getRoleWithPermissions)

/**
 * @openapi
 * /auth/roles:
 *   post:
 *     tags: [Auth]
 *     summary: Crear un nuevo rol
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       201:
 *         description: Rol creado
 */
router.post('/roles', Auth, usersModule, hasPermission('roles.manage'), controller.createRole)

/**
 * @openapi
 * /auth/roles/{id}:
 *   put:
 *     tags: [Auth]
 *     summary: Actualizar rol y sus permisos
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Rol actualizado
 */
router.put('/roles/:id', Auth, usersModule, hasPermission('roles.manage'), controller.updateRole)

/**
 * @openapi
 * /auth/roles/{id}:
 *   delete:
 *     tags: [Auth]
 *     summary: Eliminar rol (si no tiene usuarios asignados)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Rol eliminado
 */
router.delete('/roles/:id', Auth, usersModule, hasPermission('roles.manage'), controller.deleteRole)

/**
 * @openapi
 * /auth/users/{id}/photo:
 *   post:
 *     tags: [Auth]
 *     summary: Subir foto de usuario
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
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Foto subida exitosamente
 *       400:
 *         description: Archivo inválido o muy grande
 *       404:
 *         description: Usuario no encontrado
 */
router.post('/users/:id/photo', Auth, usersModule, hasPermission('users.edit'), upload.single('file'), controller.uploadPhoto)

module.exports = router
