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
 * Bulk Import Service for Products
 * Handles Excel parsing, validation, and batch import
 */
const XLSX = require('xlsx')
const prismaModel = require('../models/prisma')
const { prisma } = prismaModel
const Units = require('../modules/inventory/units')
const {importUnitInput,resolveImportUnitRow}=require('./units/importRows')
const {parseQuantity}=require('./units/quantity')
const {decimal,storageQuantity,lockPhysicalProducts,physicalSnapshot}=require('./units/physical')
const { applyBranchDelta } = require('./stockLocations')
const { ImportCancelledError } = require('../utils/importStream')
const { nameMatcher, nameCandidates, checkSimilarity, checkText, validMoney } = require('../utils/importValidation')
const { parseCatalogKind, assertServiceFields, assertServicesEnabled } = require('./catalogItemRules')

function normalizeImportOptions(raw) {
    const o = raw && typeof raw === 'object' ? raw : {}
    const createCategories = Array.isArray(o.createCategories)
        ? o.createCategories.map(s => String(s).trim()).filter(Boolean)
        : []
    const createSuppliers = Array.isArray(o.createSuppliers)
        ? o.createSuppliers.map(s => String(s).trim()).filter(Boolean)
        : []
    const skipRowIndexes = Array.isArray(o.skipRowIndexes)
        ? o.skipRowIndexes.map(n => Number(n)).filter(n => Number.isFinite(n) && n >= 2)
        : []
    return {
        createCategorySet: new Set(createCategories.map(s => s.toLowerCase())),
        createSupplierSet: new Set(createSuppliers.map(s => s.toLowerCase())),
        skipRowSet: new Set(skipRowIndexes),
        createCategories,
        createSuppliers,
        skipRowIndexes,
    }
}

const TRUE_CELL_VALUES = new Set(['si', 'sí', 'true', '1', 'yes', 'x'])
const FALSE_CELL_VALUES = new Set(['no', 'false', '0'])

/** Celda booleana en español/inglés; vacía → default. */
function parseBooleanCell(raw, defaultValue) {
    if (raw === undefined || raw === null || raw === '') return defaultValue
    const v = String(raw).trim().toLowerCase()
    if (TRUE_CELL_VALUES.has(v)) return true
    if (FALSE_CELL_VALUES.has(v)) return false
    return defaultValue
}

function mergeResolutionHints(invalidRows) {
    const catMap = new Map()
    const supMap = new Map()
    for (const ir of invalidRows) {
        const h = ir.hints || { unknownCategories: [], unknownSuppliers: [] }
        for (const c of h.unknownCategories || []) {
            const display = String(c).trim()
            if (!display) continue
            const k = display.toLowerCase()
            if (!catMap.has(k)) catMap.set(k, { value: display, rowIndexes: new Set() })
            catMap.get(k).rowIndexes.add(ir.rowIndex)
        }
        for (const s of h.unknownSuppliers || []) {
            const display = String(s).trim()
            if (!display) continue
            const k = display.toLowerCase()
            if (!supMap.has(k)) supMap.set(k, { value: display, rowIndexes: new Set() })
            supMap.get(k).rowIndexes.add(ir.rowIndex)
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
    for (const { value, rowIndexes } of supMap.values()) {
        resolutionHints.push({
            kind: 'supplier',
            value,
            rowIndexes: [...rowIndexes].sort((a, b) => a - b),
        })
    }
    return resolutionHints
}

/**
 * Parse Excel buffer and extract product rows
 * @param {Buffer} buffer - Excel file buffer
 * @returns {Object[]} Array of product rows
 */
function parseExcel(buffer) {
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const sheetName = workbook.SheetNames[0]
    const sheet = workbook.Sheets[sheetName]
    const data = XLSX.utils.sheet_to_json(sheet, { defval: '' })
    return data
}

/**
 * @param {number} i - Índice 0-based de fila de datos (fila Excel = i + 2)
 */
function validateRow(row, i, categoriesMap, suppliersMap, existingBarcodes, batchBarcodes, importOptions) {
    const errors = []
    const data = {}
    const hints = { unknownCategories: [], unknownSuppliers: [] }

    // Field aliases - support both Spanish headers and English system names
    const fieldAliases = {
        'name': ['nombre', 'name'],
        'category': ['categoria', 'category'],
        'supplier': ['proveedor', 'supplier'],
        'price': ['precio', 'price'],
        'cost': ['costo', 'cost'],
        'stock': ['stock'],
        'min_stock': ['stock_minimo', 'min_stock'],
        'brand': ['marca', 'brand'],
        'size': ['tamaño', 'size', 'tamano'],
        'barcode': ['codigo_barras', 'barcode', 'codigo'],
        'description': ['descripcion', 'description'],
        'available_for_sale': ['disponible_venta', 'disponible_para_venta', 'available_for_sale'],
        'tracks_expiry': ['controla_caducidad', 'controla_lotes', 'tracks_expiry'],
        'kind': ['tipo', 'kind'],
        'service_unit_label': ['unidad_cobro', 'service_unit_label'],
        'quantity_decimals': ['decimales', 'quantity_decimals'],
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

    try {
        const aliases = { servicio: 'SERVICE', bien: 'STANDARD', producto: 'STANDARD' }
        data.kind = parseCatalogKind(aliases[String(normalizedRow.kind).toLowerCase()] || normalizedRow.kind)
        if (data.kind === 'KIT') errors.push('Los kits requieren configurar sus componentes desde la ficha, no desde esta plantilla')
    } catch (error) { errors.push(error.message) }
    const isService = data.kind === 'SERVICE'
    if (isService) {
        if (!importOptions.servicesEnabled) errors.push('Los servicios están desactivados para esta empresa')
        const serviceFields = { service_unit_label: normalizedRow.service_unit_label, quantity_decimals: Number(normalizedRow.quantity_decimals ?? 0) }
        for (const key of ['stock','min_stock','cost','tracks_expiry','brand','size']) if (normalizedRow[key] !== undefined) serviceFields[key] = normalizedRow[key]
        if (normalizedRow.supplier !== undefined) serviceFields.supplier_id = normalizedRow.supplier
        try { assertServiceFields(serviceFields) } catch (error) { errors.push(error.message) }
        data.service_unit_label = String(normalizedRow.service_unit_label || '').trim()
        data.quantity_decimals = serviceFields.quantity_decimals
        data.supplier_id = null
    }

    // Required: name
    checkText(normalizedRow, { name: 150, category: 100, supplier: 150, brand: 100, size: 50, barcode: 100, description: 10000 }, errors)
    const nombre = String(normalizedRow.name || '').trim()
    if (!nombre) {
        errors.push('El campo "nombre" es requerido')
    } else {
        data.name = nombre
    }

    // Required: category (existente, o aprobada para crear, u omitir fila)
    const categoria = String(normalizedRow.category || '').trim()
    if (!categoria) {
        errors.push('El campo "categoria" es requerido')
    } else {
        const categoryId = categoriesMap.get(categoria.toLowerCase())
        if (categoryId) {
            data.category_id = categoryId
        } else if (importOptions.createCategorySet.has(categoria.toLowerCase())) {
            data.category_create_name = categoria
        } else {
            errors.push(
                `Categoría "${categoria}" no existe. Cree este valor en catálogo u omita las filas donde aparece.`,
            )
            hints.unknownCategories.push(categoria)
        }
    }

    // Optional habitual supplier; purchases keep their actual supplier on the receipt.
    const proveedor = String(normalizedRow.supplier || '').trim()
    if (isService) {
        data.supplier_id = null
    } else if (!proveedor) {
        data.supplier_id = null
    } else {
        const supplierId = suppliersMap.get(proveedor.toLowerCase())
        if (supplierId) {
            data.supplier_id = supplierId
        } else if (importOptions.createSupplierSet.has(proveedor.toLowerCase())) {
            data.supplier_create_name = proveedor
        } else {
            errors.push(
                `Proveedor "${proveedor}" no existe. Cree este contacto como proveedor u omita las filas donde aparece.`,
            )
            hints.unknownSuppliers.push(proveedor)
        }
    }

    const unitImport=importUnitInput(row)
    const exact=importOptions.unitsEnabled&&data.kind!=='SERVICE'
    // Required: price (must be positive number)
    const precioRaw = normalizedRow.price
    const precio = Number(precioRaw)
    if (precioRaw === '' || precioRaw === undefined || precioRaw === null) {
        errors.push('El campo "precio" es requerido')
    } else if (exact) {
        try{data.price=parseQuantity(String(precioRaw),{decimals:6,max:'9999999999.99'}).toFixed()}catch(error){errors.push(error.message)}
    } else if (!validMoney(precio) || precio <= 0) {
        errors.push(`El precio "${precioRaw}" debe ser un número finito mayor a 0 y menor que 10000000000, con hasta 2 decimales`)
    } else {
        data.price = precio
    }

    // Optional: brand
    const marca = String(normalizedRow.brand || '').trim()
    if (marca) {
        data.brand = marca
    }

    // Optional: size
    const tamano = String(normalizedRow.size || '').trim()
    if (tamano) {
        data.size = tamano
    }

    // Optional: stock (default 0, must be >= 0)
    const stockRaw = normalizedRow.stock
    if (stockRaw !== '' && stockRaw !== undefined && stockRaw !== null) {
        const stock = Number(stockRaw)
        if(exact){try{data.stock=parseQuantity(String(stockRaw),{decimals:6,allowZero:true}).toFixed()}catch(error){errors.push(error.message)}}
        else if (!Number.isInteger(stock) || stock < 0 || stock > 2147483647) {
            errors.push(`El stock "${stockRaw}" debe ser un entero entre 0 y 2147483647`)
        } else {
            data.stock = stock
        }
    } else {
        data.stock = 0
    }

    // Optional: min_stock (default 0, must be >= 0)
    const minStockRaw = normalizedRow.min_stock
    if (minStockRaw !== '' && minStockRaw !== undefined && minStockRaw !== null) {
        const minStock = Number(minStockRaw)
        if(exact){try{data.min_stock=parseQuantity(String(minStockRaw),{decimals:6,allowZero:true}).toFixed()}catch(error){errors.push(error.message)}}
        else if (!Number.isInteger(minStock) || minStock < 0 || minStock > 2147483647) {
            errors.push(`El stock mínimo "${minStockRaw}" debe ser un entero entre 0 y 2147483647`)
        } else {
            data.min_stock = minStock
        }
    } else {
        data.min_stock = 0
    }

    // Optional: cost (default 0, must be >= 0)
    const costoRaw = normalizedRow.cost
    if (costoRaw !== '' && costoRaw !== undefined && costoRaw !== null) {
        const costo = Number(costoRaw)
        if(exact){try{data.cost=parseQuantity(String(costoRaw),{decimals:6,allowZero:true,max:'9999999999.99'}).toFixed()}catch(error){errors.push(error.message)}}
        else if (!validMoney(costo)) {
            errors.push(`El costo "${costoRaw}" debe ser un número finito entre 0 y 9999999999.99, con hasta 2 decimales`)
        } else {
            data.cost = costo
        }
    } else {
        data.cost = 0
    }

    // Optional: barcode (must be unique if provided)
    const barcode = String(normalizedRow.barcode || '').trim()
    let existingProductId = null
    if (barcode) {
        if (batchBarcodes.has(barcode)) {
            errors.push(`El código de barras "${barcode}" está duplicado en el archivo`)
        } else if (existingBarcodes.has(barcode)) {
            // El catálogo es de la empresa: que el producto ya exista no es un
            // error, es que esta sucursal todavía no lo maneja (o ya lo maneja y
            // se está recargando su existencia). Ver `bulkCreateProducts`.
            existingProductId = existingBarcodes.get(barcode)
            data.barcode = barcode
            batchBarcodes.add(barcode)
        } else if (batchBarcodes.has(barcode)) {
            errors.push(`El código de barras "${barcode}" está duplicado en el archivo`)
        } else {
            data.barcode = barcode
            batchBarcodes.add(barcode)
        }
    }

    // Optional: description
    const descripcion = String(normalizedRow.description || '').trim()
    if (descripcion) {
        data.description = descripcion
    }

    // Optional: disponible_venta (default true; acepta si/no, true/false, 1/0)
    data.available_for_sale = parseBooleanCell(normalizedRow.available_for_sale, true)

    // Optional: controla_caducidad (default false; exige fecha de caducidad en ingresos futuros)
    data.tracks_expiry = parseBooleanCell(normalizedRow.tracks_expiry, false)
    if (isService) data.tracks_expiry = false
    for (const field of ['available_for_sale', 'tracks_expiry']) {
        const value = normalizedRow[field]
        if (value != null && String(value).trim() && !TRUE_CELL_VALUES.has(String(value).trim().toLowerCase()) && !FALSE_CELL_VALUES.has(String(value).trim().toLowerCase())) errors.push(`${field}: usa sí/no, true/false o 1/0`)
    }

    // Default status_id to 1 (active)
    data.status_id = 1

    return {
        valid: errors.length === 0,
        errors,
        data,
        rowIndex: i + 2,
        hints,
        // Con id, la fila no crea producto: le carga existencia en la sucursal.
        existingProductId,
        unitImport,
    }
}

/**
 * @param {Object[]} rows
 * @param {object} [importOptionsRaw]
 */
async function validateBulkData(rows, importOptionsRaw, ctx = {}) {
    const importOptions = normalizeImportOptions(importOptionsRaw)
    const { companyId } = ctx
    importOptions.unitsEnabled=await Units.unitsEnabled(prisma,companyId)
    const hasServices = rows.some(row => Object.entries(row).some(([key,value]) => ['tipo','kind'].includes(key.toLowerCase().trim()) && ['service','servicio'].includes(String(value).toLowerCase().trim())))
    importOptions.servicesEnabled = false
    if (hasServices) {
        try { await assertServicesEnabled(prisma,companyId); importOptions.servicesEnabled = true } catch (error) { if(error.status !== 403)throw error }
    }
    const barcodes = [...new Set(rows.flatMap(row => Object.entries(row)
        .filter(([key]) => ['codigo_barras', 'barcode', 'codigo'].includes(key.toLowerCase().trim()))
        .map(([, value]) => String(value ?? '').trim())).filter(Boolean))]

    const [categories, suppliers, products] = await Promise.all([
        prisma.productCategory.findMany({
            where: { deleted: false, company_id: companyId },
            select: { id: true, name: true },
        }),
        prisma.supplier.findMany({
            where: { deleted: false, party_type: 'SUPPLIER', company_id: companyId },
            select: { id: true, name: true },
        }),
        prisma.product.findMany({
            where: { company_id: companyId, deleted: false, barcode: { in: barcodes } },
            select: { id: true, barcode: true, kind: true },
        }),
    ])

    const categoriesMap = new Map(categories.map(c => [c.name.toLowerCase(), c.id]))
    const suppliersMap = new Map(suppliers.map(s => [s.name.toLowerCase(), s.id]))
    const existingBarcodes = new Map(
        products.filter((p) => p.barcode).map((p) => [p.barcode, p.id])
    )
    const batchBarcodes = new Set()
    const kindsById = new Map(products.map(p => [p.id,p.kind || 'STANDARD']))
    // ponytail: similarity candidates capped at 5000; use indexed search for very large catalogues.
    const candidates = nameCandidates(rows, ['nombre', 'name'])
    const similarProducts = candidates.length ? await prisma.product.findMany({ where: { company_id: companyId, deleted: false, OR: candidates }, select: { id: true, name: true }, take: 5000 }) : []
    const matchName = nameMatcher(similarProducts)

    const validRows = []
    const invalidRows = []
    const skippedRows = []

    for (let i = 0; i < rows.length; i++) {
        const excelRow = i + 2
        if (importOptions.skipRowSet.has(excelRow)) {
            skippedRows.push({ rowIndex: excelRow, reason: 'Omitida por el usuario' })
            continue
        }
        const result = validateRow(
            rows[i],
            i,
            categoriesMap,
            suppliersMap,
            existingBarcodes,
            batchBarcodes,
            importOptions,
        )
        if(result.valid){try{result.unitPreview=await resolveImportUnitRow(prisma,companyId,result.unitImport,result.data,result.existingProductId)}catch(error){result.errors.push(error.message);result.valid=false}}
        checkSimilarity(result, result.data.name, matchName, importOptionsRaw)
        if (result.existingProductId && (kindsById.get(result.existingProductId) === 'SERVICE' || result.data.kind === 'SERVICE')) {
            result.errors.push('El código ya pertenece a un artículo del catálogo. Edita su ficha para actualizar el servicio; esta importación no cambia tipos ni existencias de servicios')
            result.valid = false
        }
        if (result.valid) {
            validRows.push(result)
        } else {
            invalidRows.push(result)
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
        catalogs: {
            categories: categories.map(c => c.name),
            suppliers: suppliers.map(s => s.name),
        },
    }
}

async function getIdForSupplierPlaceholderCategory(companyId,db=prisma) {
    const found = await db.productCategory.findFirst({
        where: { deleted: false, company_id: companyId },
        orderBy: { id: 'asc' },
    })
    if (found) return found.id
    const created = await db.productCategory.create({ data: { name: 'General', company_id: companyId } })
    return created.id
}

async function ensureProductCategoryIdImport(name, cache, companyId,db=prisma) {
    const trimmed = String(name || '').trim()
    if (!trimmed) throw new Error('Categoría vacía')
    const key = trimmed.toLowerCase()
    if (cache.has(key)) return cache.get(key)
    let cat = await db.productCategory.findFirst({
        where: { deleted: false, company_id: companyId, name: { equals: trimmed, mode: 'insensitive' } },
    })
    if (!cat) {
        cat = await db.productCategory.create({ data: { name: trimmed.slice(0, 100), company_id: companyId } })
    }
    cache.set(key, cat.id)
    return cat.id
}

async function ensureSupplierIdForProductImport(name, cache, companyId,db=prisma) {
    const trimmed = String(name || '').trim()
    if (!trimmed) throw new Error('Proveedor vacío')
    const key = trimmed.toLowerCase()
    if (cache.has(key)) return cache.get(key)
    let sup = await db.supplier.findFirst({
        where: {
            deleted: false,
            party_type: 'SUPPLIER',
            company_id: companyId,
            name: { equals: trimmed, mode: 'insensitive' },
        },
    })
    if (sup) {
        cache.set(key, sup.id)
        return sup.id
    }
    const defaultPt = await db.paymentTerm.findFirst({
        where: { deleted: false, company_id: companyId },
        orderBy: { id: 'asc' },
    })
    if (!defaultPt) throw new Error('No hay términos de pago en el sistema')
    const catIdForSupplier = await getIdForSupplierPlaceholderCategory(companyId,db)
    const safeName = trimmed.slice(0, 150)
    sup = await db.supplier.create({
        data: {
            company_id: companyId,
            party_type: 'SUPPLIER',
            entity_kind: 'ORGANIZATION',
            name: safeName,
            contact: safeName,
            address: '—',
            supplier_payment_terms: {
                create: [{ payment_term_id: defaultPt.id, is_default: true, sort_order: 0 }],
            },
            categories: { create: [{ category: { connect: { id: catIdForSupplier } } }] },
            estado: 1,
            products: 0,
            total_purchases: 0,
        },
    })
    cache.set(key, sup.id)
    return sup.id
}

/**
 * @param {Object[]} validRows
 */
async function bulkCreateProducts(validRows, ctx = {}, onProgress = () => {}, isCancelled = () => false) {
    const { companyId, branchId, locationId } = ctx
    const unitMode=await Units.unitsEnabled(prisma,companyId)
    const errors = []
    let created = 0
    let adopted = 0
    let skipped = 0
    const categoryCache = new Map()
    const legacyRows=validRows.filter(row=>!row.unitImport?.base_unit_code&&!row.unitImport?.presentation_code&&!row.unitImport?.presentation_content)
    const supplierCache = new Map()

    for (const name of new Set((unitMode?[]:legacyRows).map(row => row.data.category_create_name).filter(Boolean))) {
        if (isCancelled()) throw new ImportCancelledError()
        await ensureProductCategoryIdImport(name, categoryCache, companyId)
    }
    for (const name of new Set((unitMode?[]:legacyRows).map(row => row.data.supplier_create_name).filter(Boolean))) {
        if (isCancelled()) throw new ImportCancelledError()
        await ensureSupplierIdForProductImport(name, supplierCache, companyId)
    }

    let processed = 0
    const saveOne = async (row) => {
        if (isCancelled()) throw new ImportCancelledError()
        try {
            const d = { ...row.data, company_id: companyId }
            if(!unitMode&&(row.unitImport?.base_unit_code||row.unitImport?.presentation_code||row.unitImport?.presentation_content))throw Error('Las unidades están desactivadas; vuelve a validar el archivo')
            Units.assertPublicProductInput(d)
            if(d.kind!=='SERVICE'&&d.quantity_decimals!==undefined&&d.quantity_decimals!==0)throw new Error('Configura una unidad base desde la ficha del producto antes de importar medidas')
            if(['base_unit_id','default_purchase_presentation_id','default_sale_presentation_id','unit_revision'].some(key=>Object.hasOwn(d,key)))throw new Error('Configura las unidades desde la ficha del producto antes de importar existencias')
            if (d.kind === 'SERVICE') {
                await assertServicesEnabled(prisma,companyId)
                assertServiceFields({service_unit_label:d.service_unit_label,quantity_decimals:d.quantity_decimals})
                if (row.existingProductId || d.supplier_create_name || d.stock || d.min_stock || d.cost || d.tracks_expiry) throw new Error('El servicio no admite existencias, proveedor ni adopción a sucursal')
                Object.assign(d,{supplier_id:null,stock:0,min_stock:0,cost:0,tracks_expiry:false,stock_assembled:false})
            }
            if(unitMode&&d.kind!=='SERVICE'){
                await prismaModel.prismaTransaction.$transaction(async tx=>{
                    await Units.lockCompany(tx,companyId)
                    const selected=await resolveImportUnitRow(tx,companyId,row.unitImport??importUnitInput({}),d,row.existingProductId)
                    const initialStock=selected?.baseStock??parseQuantity(d.stock??0,{decimals:0,allowZero:true}).toFixed()
                    const initialMin=selected?.baseMinimum??parseQuantity(d.min_stock??0,{decimals:0,allowZero:true}).toFixed()
                    if(row.existingProductId){const products=await lockPhysicalProducts(tx,[row.existingProductId],branchId);const snapshot=await physicalSnapshot(tx,products.get(row.existingProductId));await adoptIntoBranch(row.existingProductId,branchId,initialStock,initialMin,locationId,tx,snapshot);return}
                    if(d.category_create_name){d.category_id=await ensureProductCategoryIdImport(d.category_create_name,new Map(),companyId,tx);delete d.category_create_name}
                    if(d.supplier_create_name){d.supplier_id=await ensureSupplierIdForProductImport(d.supplier_create_name,new Map(),companyId,tx);delete d.supplier_create_name}
                    if(selected?.configuration)d.units_configuration=selected.configuration
                    d.stock=0;d.min_stock=storageQuantity(initialMin)
                    const finish=await Units.prepareProductWrite(tx,{companyId,branchId,permissions:['products.import']},null,{...d},d,{create:true})
                    const product=await finish(await tx.product.create({data:d}))
                    await tx.productStock.create({data:{product_id:product.id,branch_id:branchId,stock:0,min_stock:storageQuantity(initialMin)}})
                    if(!decimal(initialStock).isZero()){
                        const snapshot=await physicalSnapshot(tx,product)
                        await applyBranchDelta(tx,[[product.id,initialStock]],branchId,1,{reason:'INITIAL',refType:'product',refId:product.id,autoLotForTracked:true,...(snapshot?{unitSnapshots:new Map([[product.id,snapshot]])}:{}),...(locationId?{locationId}:{})})
                        await tx.product.update({where:{id:product.id},data:{stock:{increment:storageQuantity(initialStock)}}})
                        await tx.productStock.update({where:{product_id_branch_id:{product_id:product.id,branch_id:branchId}},data:{stock:storageQuantity(initialStock)}})
                    }
                },{maxWait:15000,timeout:30000})
                if(row.existingProductId)adopted++;else created++
                return
            }
            // Ya está en el catálogo de la empresa: no se duplica el producto, se
            // le fija la existencia en ESTA sucursal (lo que trae el archivo).
            if (row.existingProductId) {
                const initialStock = Number(d.stock || 0)
                const initialMin = Number(d.min_stock || 0)
                await prismaModel.prismaTransaction.$transaction(async tx=>{await lockPhysicalProducts(tx,[row.existingProductId],branchId);await adoptIntoBranch(row.existingProductId, branchId, initialStock, initialMin, locationId,tx)})
                adopted++
                return
            }
            if (d.category_create_name) {
                d.category_id = await ensureProductCategoryIdImport(d.category_create_name, categoryCache, companyId)
                delete d.category_create_name
            }
            if (d.supplier_create_name) {
                d.supplier_id = await ensureSupplierIdForProductImport(d.supplier_create_name, supplierCache, companyId)
                delete d.supplier_create_name
            }
            // El stock del archivo entra a la sucursal activa; products.stock es espejo
            const initialStock = Number(d.stock || 0)
            const initialMin = Number(d.min_stock || 0)
            d.stock = 0
            if (d.kind === 'SERVICE') {
              if(prisma.productBarcode)await prismaModel.prismaTransaction.$transaction(async tx=>{const finish=await Units.prepareProductWrite(tx,{companyId,branchId,permissions:['products.import']},null,d,d);return finish(await tx.product.create({data:d}))})
              else await prisma.product.create({data:d})
              created++;return
            }
            parseQuantity(initialStock,{allowZero:true});parseQuantity(initialMin,{allowZero:true})
            await prismaModel.prismaTransaction.$transaction(async tx=>{
            const prod = (await Units.unitsEnabled(tx,companyId)) || tx.productBarcode
                ? await (async()=>{const finish=await Units.prepareProductWrite(tx,{companyId,branchId,permissions:['products.import']},null,d,d);return finish(await tx.product.create({data:d}))})()
                : await tx.product.create({ data: d })
            await tx.productStock.create({
                data: {
                    product_id: prod.id,
                    branch_id: branchId,
                    stock: 0,
                    min_stock: initialMin,
                },
            })
            if (initialStock !== 0) {
                await applyBranchDelta(tx, [[prod.id, initialStock]], branchId, 1, {
                    reason: 'INITIAL', refType: 'product', refId: prod.id, autoLotForTracked: true,
                    ...(locationId ? { locationId } : {}),
                })
                await tx.product.update({
                    where: { id: prod.id },
                    data: { stock: { increment: initialStock } },
                })
                await tx.productStock.update({where:{product_id_branch_id:{product_id:prod.id,branch_id:branchId}},data:{stock:initialStock}})
            }
            })
            created++
        } catch (err) {
            skipped++
            errors.push({
                rowIndex: row.rowIndex,
                error: err.message,
            })
        } finally {
            processed++
            onProgress({ processed, total: validRows.length, created, adopted, skipped })
        }
    }

    for (let offset = 0; offset < validRows.length; offset += 4) {
        if (isCancelled()) throw new ImportCancelledError()
        const pendingByProduct = new Map()
        await Promise.all(validRows.slice(offset, offset + 4).map(row => {
            if (!row.existingProductId) return saveOne(row)
            const previous = pendingByProduct.get(row.existingProductId) || Promise.resolve()
            const task = previous.then(() => saveOne(row))
            pendingByProduct.set(row.existingProductId, task)
            return task
        }))
    }

    return { created, adopted, skipped, errors }
}

/**
 * Deja el producto (que ya existe en la empresa) con la existencia que trae el
 * archivo EN ESTA SUCURSAL. Fija, no suma: un archivo de existencias describe
 * cómo está la bodega, así que volver a importarlo no debe duplicar nada.
 */
async function adoptIntoBranch(productId, branchId, stock, minStock, locationId,db=prisma,snapshot=null) {
    const key = { product_id_branch_id: { product_id: productId, branch_id: branchId } }
    const actual = await db.productStock.findUnique({ where: key })
    const previo=decimal(actual?.stock??0)
    if (!actual) {
        await db.productStock.create({
            data: { product_id: productId, branch_id: branchId, stock: 0, min_stock: storageQuantity(minStock) },
        })
    } else if (!decimal(minStock).isZero()) {
        await db.productStock.update({ where: key, data: { min_stock: storageQuantity(minStock) } })
    }

    const delta=decimal(stock).sub(previo)
    if(delta.isZero())return
    await applyBranchDelta(db,[[productId,storageQuantity(delta.abs())]],branchId,delta.isNeg()?-1:1,{
        reason: 'INITIAL', refType: 'product', refId: productId, adjust: true, autoLotForTracked: true,
        ...(snapshot?{unitSnapshots:new Map([[productId,snapshot]])}:{}),
        ...(locationId ? { locationId } : {}),
    })
    await db.productStock.update({where:key,data:{stock:storageQuantity(stock)}})
    await db.product.update({where:{id:productId},data:{stock:{increment:storageQuantity(delta)}}})
}

/**
 * Generate Excel template with headers and example data
 * @returns {Buffer} Excel file buffer
 */
function generateTemplate() {
    const headers = [
        'nombre',
        'categoria',
        'proveedor',
        'precio',
        'costo',
        'stock',
        'stock_minimo',
        'marca',
        'tamaño',
        'codigo_barras',
        'descripcion',
        'disponible_venta',
        'controla_caducidad',
        'tipo',
        'unidad_cobro',
        'decimales',
        'base_unit_code',
        'presentation_code',
        'presentation_content'
    ]

    const example = [
        'Producto Ejemplo',
        'Bebidas',
        'Proveedor Principal',
        '25.00',
        '15.00',
        '100',
        '10',
        'Marca Ejemplo',
        '500ml',
        '07891234567890',
        'Descripción del producto',
        'si',
        'no',
        'STANDARD',
        '',
        '0',
        '',
        '',
        ''
    ]

    const ws = XLSX.utils.aoa_to_sheet([headers, example])

    // Set column widths
    ws['!cols'] = headers.map((header,index) => ({ wch: index>=16?Math.max(18,header.length+2):18 }))
    ws.J2.z='@'

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Productos')

    // Add a second sheet with valid categories and suppliers
    return wb
}

/**
 * Generate Excel template with catalogs sheet
 * @returns {Promise<Buffer>} Excel file buffer
 */
async function generateTemplateWithCatalogs(companyId) {
    const [categories, suppliers] = await Promise.all([
        prisma.productCategory.findMany({
            where: { deleted: false, company_id: companyId },
            select: { name: true },
            orderBy: { name: 'asc' },
        }),
        prisma.supplier.findMany({
            where: { deleted: false, party_type: 'SUPPLIER', company_id: companyId },
            select: { name: true },
            orderBy: { name: 'asc' },
        }),
    ])

    const headers = [
        'nombre',
        'categoria',
        'proveedor',
        'precio',
        'costo',
        'stock',
        'stock_minimo',
        'marca',
        'tamaño',
        'codigo_barras',
        'descripcion',
        'disponible_venta',
        'controla_caducidad',
        'tipo',
        'unidad_cobro',
        'decimales',
        'base_unit_code',
        'presentation_code',
        'presentation_content'
    ]

    const example = [
        'Producto Ejemplo',
        categories[0]?.name || 'Bebidas',
        suppliers[0]?.name || 'Proveedor Principal',
        '25.00',
        '15.00',
        '100',
        '10',
        'Marca Ejemplo',
        '500ml',
        '07891234567890',
        'Descripción del producto',
        'si',
        'no',
        'STANDARD',
        '',
        '0',
        '',
        '',
        ''
    ]

    const ws = XLSX.utils.aoa_to_sheet([headers, example])
    ws['!cols'] = headers.map((header,index) => ({ wch: index>=16?Math.max(18,header.length+2):18 }))
    ws.J2.z='@'

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Productos')

    // Catalogs sheet
    const maxRows = Math.max(categories.length, suppliers.length)
    const catalogData = [['Categorías Válidas', 'Proveedores Válidos']]
    for (let i = 0; i < maxRows; i++) {
        catalogData.push([
            categories[i]?.name || '',
            suppliers[i]?.name || ''
        ])
    }
    const catalogsWs = XLSX.utils.aoa_to_sheet(catalogData)
    catalogsWs['!cols'] = [{ wch: 25 }, { wch: 25 }]
    XLSX.utils.book_append_sheet(wb, catalogsWs, 'Catálogos')

    const units=await Units.unitsEnabled(prisma,companyId)?await prisma.measureUnit.findMany({where:{company_id:companyId,active:true},orderBy:{code:'asc'},select:{code:true,label:true,family:true,factor:true,quantity_decimals:true}}):[]
    const unitRows=[['Uso de unidades y costos'],['Productos nuevos: precio y costo por unidad base. No se crean presentaciones.'],['Productos existentes: precio y costo sin cambios; el archivo fija la existencia inicial de la sucursal.'],['Stock y mínimo usan la misma unidad: base, o presentación registrada cuando se declara su código.'],['El contenido verifica el factor registrado, nunca lo sustituye. Los códigos desconocidos se rechazan.'],['Guarda códigos y decimales extensos como texto para conservarlos exactamente.'],[],['Código base','Etiqueta','Familia','Factor de catálogo','Decimales máximos'],...units.map(unit=>[unit.code,unit.label,unit.family,String(unit.factor),unit.quantity_decimals])]
    const unitsWs=XLSX.utils.aoa_to_sheet(unitRows);unitsWs['!cols']=[{wch:110},{wch:16},{wch:18},{wch:24},{wch:22}];XLSX.utils.book_append_sheet(wb,unitsWs,'Unidades')
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    return buffer
}

module.exports = {
    parseExcel,
    validateBulkData,
    bulkCreateProducts,
    generateTemplate,
    generateTemplateWithCatalogs
}
