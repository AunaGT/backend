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
    } else if (password.length < 6) {
        errors.push('La contraseña debe tener al menos 6 caracteres')
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

    // Optional: phone
    const phone = String(normalizedRow.phone || '').trim()
    if (phone) {
        if (phone.length > 50) {
            errors.push('El teléfono no puede exceder 50 caracteres')
        } else {
            data.phone = phone
        }
    }

    // Optional: address
    const address = String(normalizedRow.address || '').trim()
    if (address) {
        data.address = address
    }

    // Optional: hire_date
    const hireDateStr = String(normalizedRow.hire_date || '').trim()
    if (hireDateStr) {
        let hireDate = null

        // Detectar posibles fechas en formato serial de Excel (solo dígitos)
        if (/^\d+(\.\d+)?$/.test(hireDateStr)) {
            const serial = Number(hireDateStr)
            if (!isNaN(serial)) {
                const excelEpoch = new Date(Date.UTC(1899, 11, 30)) // base Excel
                hireDate = new Date(excelEpoch.getTime() + serial * 24 * 60 * 60 * 1000)
            }
        } else {
            const parsed = new Date(hireDateStr)
            if (!isNaN(parsed.getTime())) {
                hireDate = parsed
            }
        }

        if (!hireDate || isNaN(hireDate.getTime())) {
            errors.push(`Fecha de contratación inválida: "${hireDateStr}". Use formato YYYY-MM-DD o una fecha válida.`)
        } else {
            const year = hireDate.getUTCFullYear()
            if (year < 1900 || year > 2100) {
                errors.push(`Fecha de contratación fuera de rango válido (1900-2100): "${hireDateStr}".`)
            } else {
                data.hire_date = hireDate
            }
        }
    }

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
async function bulkValidateUsers(rows, importOptionsRaw) {
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

    const roles = await prisma.role.findMany({
        select: { id: true, name: true },
    })
    const rolesMap = new Map()
    roles.forEach(role => {
        rolesMap.set(role.name.toLowerCase(), role.id)
    })

    const existingUsers = await prisma.user.findMany({
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
async function bulkCreateUsers(validRows) {
    if (!validRows || validRows.length === 0) {
        return { created: 0, skipped: 0, errors: [] }
    }

    let created = 0
    let skipped = 0
    const errors = []
    const roleCache = new Map()

    for (const row of validRows) {
        try {
            const d = { ...row.data }
            if (d.role_create_name) {
                d.role_id = await ensureRoleIdImport(d.role_create_name, roleCache)
                delete d.role_create_name
            }

            const hashedPassword = await bcrypt.hash(d.password, 10)

            const existing = await prisma.user.findUnique({
                where: { email: d.email },
            })

            if (existing) {
                skipped++
                continue
            }

            await prisma.user.create({
                data: {
                    name: d.name,
                    email: d.email,
                    password: hashedPassword,
                    role_id: d.role_id,
                    // Sin datos de RRHH: la importación crea CUENTAS. La ficha de
                    // empleado (teléfono, dirección, ingreso) se carga en RRHH, que es
                    // donde la planilla la lee.
                },
            })
            created++
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
        }
    }

    return { created, skipped, errors }
}

module.exports = {
    validateUserRow,
    bulkValidateUsers,
    bulkCreateUsers
}
