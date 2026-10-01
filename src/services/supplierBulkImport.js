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
 * Bulk Import Service for Contacts (suppliers & customers)
 * Validación estricta; valores de catálogo desconocidos se resuelven con
 */
const XLSX = require('xlsx')
const { prisma } = require('../models/prisma')
const { ImportCancelledError } = require('../utils/importStream')
const { nameMatcher, nameCandidates, cell, checkSimilarity, checkText } = require('../utils/importValidation')

function stripDiacritics(s) {
    return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/**
 * @param {unknown} raw
 * @returns {'SUPPLIER'|'CUSTOMER'|{ error: string }}
 */
function parsePartyTypeFromExcel(raw) {
    const s = stripDiacritics(String(raw ?? '').trim()).toLowerCase()
    if (!s) return 'SUPPLIER'
    const customer = new Set(['cliente', 'customer', 'comprador', 'buyer'])
    const supplier = new Set(['proveedor', 'supplier', 'vendor'])
    if (customer.has(s)) return 'CUSTOMER'
    if (supplier.has(s)) return 'SUPPLIER'
    return { error: `tipo_relacion "${String(raw).trim()}" no válido. Use proveedor o cliente.` }
}

/**
 * @param {unknown} raw
 * @returns {{ kind: 'PERSON'|'ORGANIZATION' } | { error: string }}
 */
function parseEntityKindFromExcel(raw) {
    const s = stripDiacritics(String(raw ?? '').trim()).toLowerCase()
    if (!s) return { kind: 'ORGANIZATION' }
    const personTokens = new Set(['persona', 'individual', 'natural', 'pf', 'fisica', 'person'])
    const orgTokens = new Set([
        'empresa',
        'organizacion',
        'juridica',
        'pj',
        'moral',
        'organization',
        'company',
        'org',
    ])
    if (personTokens.has(s)) return { kind: 'PERSON' }
    if (orgTokens.has(s)) return { kind: 'ORGANIZATION' }
    return { error: `Naturaleza "${String(raw).trim()}" no válida. Use empresa o persona.` }
}

/**
 * @param {unknown} raw
 */
function normalizeImportOptions(raw) {
    const o = raw && typeof raw === 'object' ? raw : {}
    const v = o.paymentTermsWhenEmpty
    const createCategories = Array.isArray(o.createCategories)
        ? o.createCategories.map(s => String(s).trim()).filter(Boolean)
        : []
    const createPaymentTerms = Array.isArray(o.createPaymentTerms)
        ? o.createPaymentTerms.map(s => String(s).trim()).filter(Boolean)
        : []
    const skipRowIndexes = Array.isArray(o.skipRowIndexes)
        ? o.skipRowIndexes.map(n => Number(n)).filter(n => Number.isFinite(n) && n >= 2)
        : []
    return {
        paymentTermsWhenEmpty: v === 'require' ? 'require' : 'default',
        createCategorySet: new Set(createCategories.map(s => s.toLowerCase())),
        createPaymentTermSet: new Set(createPaymentTerms.map(s => s.toLowerCase())),
        skipRowSet: new Set(skipRowIndexes),
        createCategories,
        createPaymentTerms,
        skipRowIndexes,
    }
}

function mergeResolutionHints(invalidRows) {
    const catMap = new Map()
    const ptMap = new Map()
    for (const ir of invalidRows) {
        const h = ir.hints || { unknownCategories: [], unknownPaymentTerms: [] }
        for (const c of h.unknownCategories || []) {
            const display = String(c).trim()
            if (!display) continue
            const k = display.toLowerCase()
            if (!catMap.has(k)) catMap.set(k, { value: display, rowIndexes: new Set() })
            catMap.get(k).rowIndexes.add(ir.rowIndex)
        }
        for (const p of h.unknownPaymentTerms || []) {
            const display = String(p).trim()
            if (!display) continue
            const k = display.toLowerCase()
            if (!ptMap.has(k)) ptMap.set(k, { value: display, rowIndexes: new Set() })
            ptMap.get(k).rowIndexes.add(ir.rowIndex)
        }
    }
    const resolutionHints = []
    for (const { value, rowIndexes } of catMap.values()) {
        resolutionHints.push({
            kind: 'category',
            value,
            rowIndexes: [...rowIndexes].sort((a, b) => a - b),
        })
    }
    for (const { value, rowIndexes } of ptMap.values()) {
        resolutionHints.push({
            kind: 'payment_term',
            value,
            rowIndexes: [...rowIndexes].sort((a, b) => a - b),
        })
    }
    return resolutionHints
}

/**
 * Parse Excel buffer and extract supplier rows
 * @param {Buffer} buffer - Excel file buffer
 * @returns {Object[]} Array of supplier rows
 */
function parseExcel(buffer) {
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const sheetName = workbook.SheetNames[0]
    const sheet = workbook.Sheets[sheetName]
    const data = XLSX.utils.sheet_to_json(sheet, { defval: '' })
    return data
}

/**
 * @param {Map<string, number>} categoriesMap
 * @param {Map<string, number>} paymentTermsMap
 */
function validateSupplierRow(
    row,
    rowIndex,
    existingEmails,
    batchEmails,
    importOptions,
    categoriesMap,
    paymentTermsMap,
) {
    const errors = []
    const data = {}
    const hints = { unknownCategories: [], unknownPaymentTerms: [] }
    const paymentOpt = importOptions

    const fieldAliases = {
        party_type: [
            'tipo_relacion',
            'party_type',
            'rol_contacto',
            'tipo_contacto_negocio',
            'relacion',
        ],
        entity_kind: [
            'naturaleza_contacto',
            'naturaleza',
            'tipo_entidad',
            'entidad',
            'tipo_contacto',
            'entity_kind',
        ],
        name: ['nombre', 'name', 'empresa', 'razon_social'],
        contact: ['contacto', 'contact', 'persona_contacto'],
        phone: ['telefono', 'phone', 'tel'],
        email: ['email', 'correo', 'correo_electronico'],
        address: ['direccion', 'address', 'domicilio'],
        category: ['categoria', 'category'],
        payment_terms: ['terminos_pago', 'payment_terms', 'pago'],
        tax_id: ['id_fiscal', 'nit', 'tax_id', 'rfc'],
    }

    const normalizedRow = {}
    const rowLower = {}
    for (const key of Object.keys(row)) {
        rowLower[key.toLowerCase().trim()] = row[key]
    }

    for (const [standardName, aliases] of Object.entries(fieldAliases)) {
        for (const alias of aliases) {
            if (rowLower[alias] !== undefined && rowLower[alias] !== '') {
                normalizedRow[standardName] = rowLower[alias]
                break
            }
        }
    }

    let partyType = 'SUPPLIER'
    checkText(normalizedRow, { name: 150, contact: 100, phone: 50, email: 150, address: 10000, tax_id: 100 }, errors)
    const rawParty = normalizedRow.party_type
    if (rawParty !== undefined && rawParty !== null && String(rawParty).trim() !== '') {
        const parsed = parsePartyTypeFromExcel(rawParty)
        if (parsed.error) {
            errors.push(parsed.error)
        } else {
            partyType = parsed
        }
    }
    data.party_type = partyType

    let entityKind = 'ORGANIZATION'
    const rawEntity = normalizedRow.entity_kind
    if (rawEntity !== undefined && rawEntity !== null && String(rawEntity).trim() !== '') {
        const parsed = parseEntityKindFromExcel(rawEntity)
        if (parsed.error) {
            errors.push(parsed.error)
        } else {
            entityKind = parsed.kind
        }
    }
    data.entity_kind = entityKind

    const nombre = String(normalizedRow.name || '').trim()
    if (!nombre) {
        errors.push('El campo "nombre" es requerido')
    } else {
        data.name = nombre
    }

    const contacto = String(normalizedRow.contact || '').trim()
    if (entityKind === 'ORGANIZATION') {
        if (!contacto) {
            errors.push('El campo "contacto" es requerido cuando la naturaleza es empresa')
        } else {
            data.contact = contacto
        }
    } else {
        data.contact = contacto || nombre
    }

    const telefono = String(normalizedRow.phone || '').trim()
    if (!telefono) {
        errors.push('El campo "telefono" es requerido')
    } else {
        data.phone = telefono
        if (!/^[+\d\s().-]{5,50}$/.test(telefono) || telefono.replace(/\D/g, '').length < 5) errors.push('telefono: formato inválido; usa números y un prefijo internacional opcional')
    }

    const email = String(normalizedRow.email || '').trim().toLowerCase()
    if (!email) {
        if (partyType === 'SUPPLIER') {
            errors.push('El campo "email" es requerido para proveedores')
        } else {
            data.email = null
        }
    } else {
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

    const direccion = String(normalizedRow.address || '').trim()
    if (!direccion) {
        errors.push('El campo "direccion" es requerido')
    } else {
        data.address = direccion
    }

    if (partyType === 'SUPPLIER') {
        const categoria = String(normalizedRow.category || '').trim()
        if (!categoria) {
            errors.push('La categoría es obligatoria para proveedores (los clientes no usan categoría)')
        } else {
            const rawNames = categoria
                .split(/[;,/]/)
                .map(v => v.trim())
                .filter(Boolean)
            if (rawNames.length === 0) {
                errors.push('La categoría es obligatoria para proveedores')
            } else {
                const resolvedLabels = []
                for (const name of rawNames) {
                    const inDb = categoriesMap.has(name.toLowerCase())
                    const approved = paymentOpt.createCategorySet.has(name.toLowerCase())
                    if (inDb || approved) {
                        resolvedLabels.push(name)
                    } else {
                        errors.push(
                            `Categoría "${name}" no existe. Cree este valor en catálogo u omita las filas donde aparece.`,
                        )
                        hints.unknownCategories.push(name)
                    }
                }
                if (resolvedLabels.length === rawNames.length && rawNames.length > 0) {
                    data.category_labels = resolvedLabels
                }
            }
        }
    }

    const terminosPago = String(normalizedRow.payment_terms || '').trim()
    if (!terminosPago) {
        if (paymentOpt.paymentTermsWhenEmpty === 'require') {
            errors.push('El campo "terminos_pago" es requerido (o elija usar término por defecto en la importación)')
        } else {
            data.payment_terms_use_default = true
        }
    } else {
        const parts = terminosPago
            .split(/[|;,\n]/)
            .map((s) => String(s).trim())
            .filter(Boolean)
        const unknown = []
        const resolvedNames = []
        for (const part of parts) {
            const inDb = paymentTermsMap.has(part.toLowerCase())
            const approved = paymentOpt.createPaymentTermSet.has(part.toLowerCase())
            if (inDb || approved) {
                resolvedNames.push(part)
            } else {
                unknown.push(part)
            }
        }
        if (unknown.length > 0) {
            for (const u of unknown) {
                errors.push(
                    `Término de pago "${u}" no existe. Cree este valor u omita las filas donde aparece.`,
                )
                hints.unknownPaymentTerms.push(u)
            }
        } else if (resolvedNames.length > 0) {
            data.payment_term_names = resolvedNames
        }
    }

    const taxRaw = normalizedRow.tax_id
    if (taxRaw !== undefined && taxRaw !== null && String(taxRaw).trim() !== '') {
        data.tax_id = String(taxRaw).trim()
    }

    return {
        valid: errors.length === 0,
        errors,
        data,
        rowIndex,
        hints,
    }
}

/**
 * @param {Object[]} rows
 * @param {object} [importOptionsRaw]
 * @returns {Promise<Object>}
 */
async function bulkValidateSuppliers(rows, importOptionsRaw, ctx = {}) {
    const importOptions = normalizeImportOptions(importOptionsRaw)
    const { companyId } = ctx
    const emails = rows.map(row => String(cell(row, ['email', 'correo', 'correo_electronico'])).trim().toLowerCase()).filter(Boolean)
    const taxIds = rows.map(row => String(cell(row, ['id_fiscal', 'nit', 'tax_id', 'rfc'])).trim()).filter(Boolean)

    const [categoriesRaw, paymentTermsRaw, existingSuppliersRaw] = await Promise.all([
        prisma.productCategory.findMany({
            where: { deleted: false, company_id: companyId },
            select: { id: true, name: true },
        }),
        prisma.paymentTerm.findMany({
            where: { deleted: false, company_id: companyId },
            select: { id: true, name: true },
        }),
        prisma.supplier.findMany({
            where: { deleted: false, company_id: companyId, OR: [{ email: { in: emails, mode: 'insensitive' } }, { tax_id: { in: taxIds, mode: 'insensitive' } }] },
            select: { id: true, name: true, email: true, tax_id: true },
        }),
    ])
    const categoriesMap = new Map(categoriesRaw.map(c => [c.name.toLowerCase(), c.id]))
    const paymentTermsMap = new Map(paymentTermsRaw.map(p => [p.name.toLowerCase(), p.id]))

    const existingEmails = new Set(
        existingSuppliersRaw.map(s => s.email?.toLowerCase()).filter(Boolean),
    )

    const batchEmails = new Set()
    const candidates = nameCandidates(rows, ['nombre', 'name', 'empresa', 'razon_social'])
    const similarSuppliers = candidates.length ? await prisma.supplier.findMany({ where: { company_id: companyId, deleted: false, OR: candidates }, select: { id: true, name: true }, take: 5000 }) : []
    const matchName = nameMatcher(similarSuppliers)
    const fiscalIds = new Set(existingSuppliersRaw.map(s => s.tax_id?.trim().toLowerCase()).filter(Boolean))

    const validRows = []
    const invalidRows = []
    const skippedRows = []

    for (let i = 0; i < rows.length; i++) {
        const rowIndex = i + 2
        if (importOptions.skipRowSet.has(rowIndex)) {
            skippedRows.push({ rowIndex, reason: 'Omitida por el usuario' })
            continue
        }
        const result = validateSupplierRow(
            rows[i],
            rowIndex,
            existingEmails,
            batchEmails,
            importOptions,
            categoriesMap,
            paymentTermsMap,
        )
        if (result.data.tax_id && result.data.tax_id.toLowerCase() !== 'cf') {
            const key = result.data.tax_id.toLowerCase()
            if (fiscalIds.has(key)) result.errors.push(`ID fiscal "${result.data.tax_id}" duplicado en el sistema o archivo`)
            fiscalIds.add(key)
        }
        result.valid = result.errors.length === 0
        checkSimilarity(result, result.data.name, matchName, importOptionsRaw)

        if (result.valid) {
            validRows.push({ rowIndex: result.rowIndex, data: result.data })
        } else {
            invalidRows.push({
                rowIndex: result.rowIndex,
                errors: result.errors,
                hints: result.hints,
                canCreateAnyway: result.canCreateAnyway,
                similarMatches: result.similarMatches,
            })
        }
    }

    const resolutionHints = mergeResolutionHints(invalidRows)

    return {
        validRows,
        invalidRows,
        skippedRows,
        resolutionHints,
        totals: {
            total: rows.length,
            valid: validRows.length,
            invalid: invalidRows.length,
            skipped: skippedRows.length,
        },
    }
}

async function getDefaultPaymentTermId(companyId) {
    const first = await prisma.paymentTerm.findFirst({
       where: { deleted: false, company_id: companyId },
       orderBy: { id: 'asc' },
    })
    if (!first) throw new Error('No hay términos de pago en el sistema. Cree al menos uno.')
    return first.id
}

/**
 * @param {string} name
 * @param {Map<string, number>} cache lower -> id
 */
async function ensureProductCategoryId(name, cache, companyId) {
    const trimmed = String(name || '').trim()
    if (!trimmed) return null
    const key = trimmed.toLowerCase()
    if (cache.has(key)) return cache.get(key)

    let cat = await prisma.productCategory.findFirst({
        where: { deleted: false, company_id: companyId, name: { equals: trimmed, mode: 'insensitive' } },
    })
    if (!cat) {
        const safe = trimmed.slice(0, 100)
        cat = await prisma.productCategory.create({ data: { name: safe, company_id: companyId } })
    }
    cache.set(key, cat.id)
    return cat.id
}

/**
 * @param {string} name
 * @param {Map<string, number>} cache
 */
async function ensurePaymentTermId(name, cache, companyId) {
    const trimmed = String(name || '').trim()
    if (!trimmed) return null
    const key = trimmed.toLowerCase()
    if (cache.has(key)) return cache.get(key)

    let pt = await prisma.paymentTerm.findFirst({
        where: { deleted: false, company_id: companyId, name: { equals: trimmed, mode: 'insensitive' } },
    })
    if (!pt) {
        const safe = trimmed.slice(0, 50)
        pt = await prisma.paymentTerm.create({ data: { name: safe, company_id: companyId } })
    }
    cache.set(key, pt.id)
    return pt.id
}

/**
 * @param {Object[]} validRows
 * @param {object} [importOptionsRaw]
 * @returns {Promise<Object>}
 */
async function bulkCreateSuppliers(validRows, importOptionsRaw, ctx = {}, onProgress = () => {}, isCancelled = () => false) {
    const { companyId } = ctx
    normalizeImportOptions(importOptionsRaw)

    const errors = []
    let created = 0
    let skipped = 0
    const categoryCache = new Map()
    const paymentCache = new Map()
    let defaultPaymentIdPromise
    const resolveDefaultPaymentId = () => (defaultPaymentIdPromise ||= getDefaultPaymentTermId(companyId))

    // Resolve shared catalog values once before independent contact writes.
    for (const label of new Set(validRows.flatMap(row => (row.data.party_type || 'SUPPLIER') === 'SUPPLIER' ? row.data.category_labels || [] : []))) {
        if (isCancelled()) throw new ImportCancelledError()
        await ensureProductCategoryId(label, categoryCache, companyId)
    }
    for (const label of new Set(validRows.flatMap(row => row.data.payment_term_names || []))) {
        if (isCancelled()) throw new ImportCancelledError()
        await ensurePaymentTermId(label, paymentCache, companyId)
    }

    let processed = 0
    const saveOne = async (row) => {
        if (isCancelled()) throw new ImportCancelledError()
        try {
            const partyType = row.data.party_type || 'SUPPLIER'
            const createData = {
                party_type: partyType,
                entity_kind: row.data.entity_kind || 'ORGANIZATION',
                name: row.data.name,
                contact: row.data.contact,
                phone: row.data.phone,
                email: row.data.email,
                address: row.data.address,
                products: 0,
                total_purchases: 0,
                estado: 1,
            }
            if (row.data.tax_id) {
                createData.tax_id = row.data.tax_id
            }

            if (partyType === 'SUPPLIER' && Array.isArray(row.data.category_labels) && row.data.category_labels.length > 0) {
                const ids = []
                for (const label of row.data.category_labels) {
                    const id = await ensureProductCategoryId(label, categoryCache, companyId)
                    if (id && !ids.includes(id)) ids.push(id)
                }
                if (ids.length > 0) {
                    createData.categories = {
                        create: ids.map(id => ({ category: { connect: { id } } })),
                    }
                }
            }

            if (row.data.payment_terms_use_default) {
                const defId = await resolveDefaultPaymentId()
                createData.supplier_payment_terms = {
                    create: [{ payment_term_id: defId, is_default: true, sort_order: 0 }],
                }
            } else if (Array.isArray(row.data.payment_term_names) && row.data.payment_term_names.length > 0) {
                const ids = []
                for (let i = 0; i < row.data.payment_term_names.length; i++) {
                    const ptId = await ensurePaymentTermId(row.data.payment_term_names[i], paymentCache, companyId)
                    if (ptId) ids.push(ptId)
                }
                if (ids.length === 0) {
                    throw new Error('No se pudieron resolver los términos de pago')
                }
                createData.supplier_payment_terms = {
                    create: ids.map((ptId, i) => ({
                        payment_term_id: ptId,
                        is_default: i === 0,
                        sort_order: i,
                    })),
                }
            } else {
                const defId = await resolveDefaultPaymentId()
                createData.supplier_payment_terms = {
                    create: [{ payment_term_id: defId, is_default: true, sort_order: 0 }],
                }
            }

            await prisma.supplier.create({ data: { ...createData, company_id: companyId } })
            created++
        } catch (err) {
            skipped++
            errors.push({
                rowIndex: row.rowIndex,
                error: err.message,
            })
        } finally {
            processed++
            onProgress({ processed, total: validRows.length, created, skipped })
        }
    }

    for (let offset = 0; offset < validRows.length; offset += 4) {
        if (isCancelled()) throw new ImportCancelledError()
        await Promise.all(validRows.slice(offset, offset + 4).map(saveOne))
    }

    return { created, skipped, errors }
}

/**
 * @returns {Promise<Buffer>}
 */
async function generateSupplierTemplate(companyId) {
    const [paymentTerms] = await Promise.all([
        prisma.paymentTerm.findMany({
            where: { deleted: false, company_id: companyId },
            select: { name: true },
            orderBy: { name: 'asc' },
            take: 5,
        }),
    ])

    const headers = [
        'tipo_relacion',
        'naturaleza_contacto',
        'nombre',
        'contacto',
        'telefono',
        'email',
        'direccion',
        'categoria',
        'terminos_pago',
        'id_fiscal',
    ]

    const exampleSupplierOrg = [
        'proveedor',
        'empresa',
        'Distribuidora Ejemplo, S.A.',
        'Juan Pérez',
        '+502 5555-1234',
        'compras@ejemplo.com',
        'Zona 10, Ciudad de Guatemala',
        'Bebidas; Snacks',
        paymentTerms[0]?.name || '30 días',
        '',
    ]

    const exampleClientPerson = [
        'cliente',
        'persona',
        'María López',
        '',
        '+502 5555-9999',
        'maria@email.com',
        'Ciudad',
        '',
        paymentTerms[0]?.name || 'Contado',
        '12345678-9',
    ]

    const workbook = XLSX.utils.book_new()
    const worksheet = XLSX.utils.aoa_to_sheet([headers, exampleSupplierOrg, exampleClientPerson])

    worksheet['!cols'] = [
        { wch: 14 },
        { wch: 20 },
        { wch: 28 },
        { wch: 22 },
        { wch: 18 },
        { wch: 30 },
        { wch: 35 },
        { wch: 28 },
        { wch: 22 },
        { wch: 18 },
    ]

    XLSX.utils.book_append_sheet(workbook, worksheet, 'Contactos')

    const helpRows = [
        ['Instrucciones'],
        [''],
        ['tipo_relacion: proveedor o cliente. Si se omite, se asume proveedor.'],
        ['naturaleza_contacto: empresa o persona (vacío = empresa).'],
        ['  — Cliente + empresa: nombre = razón social; contacto = persona de contacto (obligatorio).'],
        ['  — Cliente + persona: nombre = nombre completo; contacto puede ir vacío.'],
        ['  — Proveedor + empresa: igual que cliente empresa; categoría obligatoria.'],
        ['  — Proveedor + persona: nombre y categoría obligatorios; contacto puede vaciarse (se usa el nombre).'],
        ['categoria: obligatoria solo para proveedores (una o varias separadas por ; , o /). Si el nombre no existe en el catálogo, «Probar» fallará hasta que en pantalla elija «Crear» esa categoría u «Omitir» las filas.'],
        ['terminos_pago: si el nombre no existe, mismo criterio: crear el término desde la importación u omitir filas.'],
        ['  Celda vacía: en pantalla puede usarse el término por defecto del sistema o exigir valor en cada fila.'],
        ['email: obligatorio para proveedores; opcional para clientes (celda vacía = sin email).'],
        ['id_fiscal: opcional.'],
    ]
    const helpWs = XLSX.utils.aoa_to_sheet(helpRows)
    helpWs['!cols'] = [{ wch: 92 }]
    XLSX.utils.book_append_sheet(workbook, helpWs, 'Instrucciones')

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
    return buffer
}

module.exports = {
    parseExcel,
    validateSupplierRow,
    bulkValidateSuppliers,
    bulkCreateSuppliers,
    generateSupplierTemplate,
}
