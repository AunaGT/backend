/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

/**
 * Bulk Import Service for Users
 * Handles validation and batch import for users
 */
const bcrypt = require('bcryptjs')
const { prisma } = require('../models/prisma')
const { assertGrant, fail } = require('./userAccess')
const { ImportCancelledError } = require('../utils/importStream')

function normalizeImportOptions(raw) {
    const o = raw && typeof raw === 'object' ? raw : {}
    const createRoles = Array.isArray(o.createRoles)
        ? o.createRoles.map(s => String(s).trim()).filter(Boolean)
        : []
    const skipRowIndexes = Array.isArray(o.skipRowIndexes)
        ? o.skipRowIndexes.map(n => Number(n)).filter(n => Number.isFinite(n) && n >= 2)
        : []
    return {
        createRoleSet: new Set(createRoles.map(s => s.toLowerCase())),
        skipRowSet: new Set(skipRowIndexes),
        createRoles,
        skipRowIndexes,
    }
}

function mergeResolutionHints(invalidRows) {
    const roleMap = new Map()
    for (const ir of invalidRows) {
        const unknown = ir.hints?.unknownRoles || []
        for (const r of unknown) {
            const display = String(r).trim()
            if (!display) continue
            const k = display.toLowerCase()
            if (!roleMap.has(k)) roleMap.set(k, { value: display, rowIndexes: new Set() })
            roleMap.get(k).rowIndexes.add(ir.rowIndex)
        }
    }
    return [...roleMap.values()].map(({ value, rowIndexes }) => ({
        kind: 'role',
        value,
        rowIndexes: [...rowIndexes].sort((a, b) => a - b),
    }))
}

/**
 * @param {number} excelRow - Número de fila en Excel (fila 1 = encabezado; primera fila de datos = 2)
 */
function validateUserRow(row, excelRow, rolesMap, existingEmails, batchEmails, importOptions) {
    const errors = []
    const data = {}
    const hints = { unknownRoles: [] }

    // Field aliases - support both Spanish headers and English system names
    const fieldAliases = {
        'name': ['nombre', 'name'],
        'email': ['email', 'correo', 'correo_electronico'],
        'password': ['password', 'contraseña', 'contrasena'],
        'role': ['rol', 'role', 'role_id', 'rol_id'],
        'is_employee': ['es_empleado', 'is_employee', 'empleado'],
        'phone': ['telefono', 'phone', 'tel'],
        'address': ['direccion', 'address', 'domicilio'],
        'hire_date': ['fecha_contratacion', 'hire_date', 'fecha_contrato']
    }

    // Normalize row keys (lowercase, trim) and resolve aliases
    const normalizedRow = {}
    const rowLower = {}
    for (const key of Object.keys(row)) {
        rowLower[key.toLowerCase().trim()] = row[key]
    }

    // Map aliases to standard field names
    for (const [standardName, aliases] of Object.entries(fieldAliases)) {
        for (const alias of aliases) {
            if (rowLower[alias] !== undefined && rowLower[alias] !== '') {
                normalizedRow[standardName] = rowLower[alias]
                break
            }
        }
    }

    // Required: name
    const name = String(normalizedRow.name || '').trim()
    if (!name) {
        errors.push('El campo "nombre" es requerido')
    } else if (name.length < 2) {
        errors.push('El nombre debe tener al menos 2 caracteres')
    } else if (name.length > 150) {
        errors.push('El nombre no puede exceder 150 caracteres')
    } else {
        data.name = name
    }

    // Required: email (must be unique)
    const email = String(normalizedRow.email || '').trim().toLowerCase()
    if (!email) {
        errors.push('El campo "email" es requerido')
    } else {
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        if (!emailRegex.test(email)) {
            errors.push(`Email "${email}" tiene formato inválido`)
        } else if (existingEmails.has(email)) {
            errors.push(`Email "${email}" ya existe en el sistema`)
        } else if (batchEmails.has(email)) {
            errors.push(`Email "${email}" está duplicado en el archivo`)
        } else {
            data.email = email
            batchEmails.add(email)
        }
    }

    // Required: password
    const password = String(normalizedRow.password || '').trim()
    if (!password) {
        errors.push('El campo "password" es requerido')
    } else if (password.length < 10 || Buffer.byteLength(password) > 72) {
        errors.push('La contraseña debe tener al menos 10 caracteres y máximo 72 bytes')
    } else {
        data.password = password // Will be hashed later
    }

    // Required: rol existente, aprobado para crear, u omitir fila
    const roleName = String(normalizedRow.role || '').trim()
    if (!roleName) {
        errors.push('El campo "rol" es requerido')
    } else {
        const roleId = rolesMap.get(roleName.toLowerCase())
        if (roleId) {
            data.role_id = roleId
        } else if (importOptions.createRoleSet.has(roleName.toLowerCase())) {
            data.role_create_name = roleName
        } else {
            errors.push(
                `Rol "${roleName}" no existe. Cree este rol en catálogo u omita las filas donde aparece.`,
            )
            hints.unknownRoles.push(roleName)
        }
    }

    // "es_empleado" ya no se importa: ser empleado es tener ficha en RRHH, no una
    // casilla. Se acepta la columna en el archivo y se ignora, para que a nadie se
    // le caiga una plantilla vieja; se avisa para que sepan dónde cargarlo.
    const isEmployeeStr = String(normalizedRow.is_employee || '').trim().toLowerCase()
    if (isEmployeeStr) {
        {
            // Se ignora en silencio: no es un error del archivo, es una columna que
            // dejó de aplicar. Rechazar la fila por esto sería peor que ignorarla.
        }
    }

    // "telefono"/"direccion"/"fecha_contratacion" ya no se importan al usuario: viven
    // en la ficha de empleado (RRHH). Igual que es_empleado, se aceptan si vienen en
    // el archivo y se ignoran, para no romper plantillas viejas.

    return {
        valid: errors.length === 0,
        errors,
        data: errors.length === 0 ? data : null,
        hints,
        rowIndex: excelRow,
    }
}

/**
 * @param {Array} rows - Filas ya mapeadas (sin encabezado Excel; fila índice 0 → Excel fila 2)
 * @param {object} [importOptionsRaw]
 */
async function bulkValidateUsers(rows, importOptionsRaw, context) {
    if (!context?.companyId || !context?.user) fail(400, 'Empresa requerida')
    if (!Array.isArray(rows) || rows.length > 1000) fail(400, 'Máximo 1000 filas por importación')
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
        return {
            validRows: [],
            invalidRows: [],
            skippedRows: [],
            resolutionHints: [],
            totals: { total: 0, valid: 0, invalid: 0, skipped: 0 },
        }
    }

    const importOptions = normalizeImportOptions(importOptionsRaw)
    if (importOptions.createRoles.length) fail(400, 'Crea los roles desde Roles y permisos antes de importar')

    const roles = await prisma.role.findMany({
        where: { OR: [{ company_id: context.companyId }, { company_id: null }] },
        include: { permissions: { include: { permission: true } } },
    })
    const rolesMap = new Map()
    roles.forEach(role => {
        try { assertGrant(context.user, role); rolesMap.set(role.name.toLowerCase(), role.id) } catch (e) { if (e.status !== 403) throw e }
    })

    const incomingEmails = [...new Set(rows.flatMap(row => Object.entries(row)
        .filter(([key]) => ['email', 'correo', 'correo_electronico'].includes(key.toLowerCase().trim()))
        .map(([, value]) => String(value ?? '').trim().toLowerCase())).filter(Boolean))]
    const existingUsers = await prisma.user.findMany({
        where: { email: { in: incomingEmails, mode: 'insensitive' } },
        select: { email: true },
    })
    const existingEmails = new Set(existingUsers.map(u => u.email.toLowerCase()))

    const batchEmails = new Set()

    const validRows = []
    const invalidRows = []
    const skippedRows = []

    rows.forEach((row, index) => {
        const excelRow = index + 2
        if (importOptions.skipRowSet.has(excelRow)) {
            skippedRows.push({ rowIndex: excelRow, reason: 'Omitida por el usuario' })
            return
        }
        const validation = validateUserRow(row, excelRow, rolesMap, existingEmails, batchEmails, importOptions)

        if (validation.valid && validation.data) {
            validRows.push({
                rowIndex: validation.rowIndex,
                data: validation.data,
            })
        } else {
            invalidRows.push({
                rowIndex: validation.rowIndex,
                errors: validation.errors,
                hints: validation.hints,
                data: row,
            })
        }
    })

    return {
        validRows,
        invalidRows,
        skippedRows,
        resolutionHints: mergeResolutionHints(invalidRows),
        totals: {
            total: rows.length,
            valid: validRows.length,
            invalid: invalidRows.length,
            skipped: skippedRows.length,
        },
    }
}

async function ensureRoleIdImport(name, cache) {
    const trimmed = String(name || '').trim()
    if (!trimmed) throw new Error('Rol vacío')
    const key = trimmed.toLowerCase()
    if (cache.has(key)) return cache.get(key)
    let role = await prisma.role.findFirst({
        where: { name: { equals: trimmed, mode: 'insensitive' } },
    })
    if (!role) {
        const safeName = trimmed.slice(0, 50)
        role = await prisma.role.create({ data: { name: safeName } })
    }
    cache.set(key, role.id)
    return role.id
}

/**
 * Bulk create users
 * @param {Array} validRows - Array of validated user rows
 * @returns {Object} Result with created count and skipped count
 */
async function bulkCreateUsers(validRows, context, onProgress = () => {}, isCancelled = () => false) {
    if (!context?.companyId || !context?.user) fail(400, 'Empresa requerida')
    if (!validRows || validRows.length === 0) {
        return { created: 0, skipped: 0, errors: [] }
    }

    let created = 0
    let skipped = 0
    const errors = []
    const roleIds = [...new Set(validRows.map(row => row.data.role_id).filter(Boolean))]
    const roles = await prisma.role.findMany({
        where: { id: { in: roleIds }, OR: [{ company_id: context.companyId }, { company_id: null }] },
        include: { permissions: { include: { permission: true } } },
    })
    const rolesById = new Map(roles.map(role => [role.id, role]))
    const emails = validRows.map(row => row.data.email)
    const existing = await prisma.user.findMany({ where: { email: { in: emails, mode: 'insensitive' } }, select: { email: true } })
    const existingEmails = new Set(existing.map(user => user.email.toLowerCase()))
    let processed = 0

    for (const row of validRows) {
        if (isCancelled()) throw new ImportCancelledError()
        try {
            const d = { ...row.data }
            if (d.role_create_name) fail(400, 'Crea el rol antes de importar')
            const role = rolesById.get(d.role_id)
            if (!role) fail(400, 'Rol no disponible')
            assertGrant(context.user, role)

            if (existingEmails.has(d.email.toLowerCase())) {
                skipped++
                continue
            }
            const hashedPassword = await bcrypt.hash(d.password, 10)

            await prisma.user.create({
                data: {
                    name: d.name,
                    email: d.email,
                    password: hashedPassword,
                    role_id: d.role_id,
                    user_companies: { create: { company_id: context.companyId, role_id: d.role_id } },
                    ...(context.branchId ? { default_branch_id: context.branchId, user_branches: { create: { branch_id: context.branchId } } } : {}),
                    // Sin datos de RRHH: la importación crea CUENTAS. La ficha de
                    // empleado (teléfono, dirección, ingreso) se carga en RRHH, que es
                    // donde la planilla la lee.
                },
            })
            created++
            existingEmails.add(d.email.toLowerCase())
        } catch (e) {
            if (e.code === 'P2002') {
                // Unique constraint violation - duplicate email
                skipped++
            } else {
                errors.push({
                    rowIndex: row.rowIndex,
                    error: e.message || 'Error desconocido'
                })
            }
        } finally {
            processed++
            onProgress({ processed, total: validRows.length, created, skipped })
        }
    }

    return { created, skipped, errors }
}

module.exports = {
    validateUserRow,
    bulkValidateUsers,
    bulkCreateUsers
}
