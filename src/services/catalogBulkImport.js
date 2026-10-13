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
 * Bulk Import Service for Catalogs (Categories and Payment Terms)
 * Handles validation and batch import for catalog items
 */
const { prisma } = require('../models/prisma')
const { ImportCancelledError } = require('../utils/importStream')
const { nameMatcher, checkSimilarity, checkText, cell, rowSet } = require('../utils/importValidation')

/**
 * Validate a single catalog item row
 * @param {Object} row - Catalog item row data
 * @param {number} rowIndex - Row index for error reporting
 * @param {string} type - 'categories' or 'payment-terms'
 * @param {Set} existingNames - Set of existing names in DB
 * @param {Set} batchNames - Set of names seen in current batch
 * @returns {Object} { valid: boolean, errors: string[], data: Object }
 */
function validateCatalogRow(row, rowIndex, type, existingNames, batchNames) {
    const errors = []
    const data = {}

    // Field aliases - support both Spanish headers and English system names
    const fieldAliases = {
        'name': ['nombre', 'name', 'nombre_categoria', 'nombre_termino']
    }

    // Normalize row keys (lowercase, trim) and resolve aliases
    const normalizedRow = {}
    for (const key of Object.keys(row)) {
        const lowerKey = key.toLowerCase().trim()
        for (const [systemField, aliases] of Object.entries(fieldAliases)) {
            if (aliases.includes(lowerKey)) {
                normalizedRow[systemField] = String(row[key] || '').trim()
                break
            }
        }
    }

    // Validate name (required)
    checkText(normalizedRow, { name: 100 }, errors)
    const name = normalizedRow.name || ''
    if (!name) {
        errors.push('El nombre es requerido')
    } else if (name.length < 2) {
        errors.push('El nombre debe tener al menos 2 caracteres')
    } else if (name.length > 100) {
        errors.push('El nombre no puede exceder 100 caracteres')
    } else {
        data.name = name

        // Check for duplicates in database
        if (existingNames.has(name.toLowerCase())) {
            errors.push(`Ya existe un ${type === 'categories' ? 'categoría' : 'término de pago'} con el nombre "${name}"`)
        }

        // Check for duplicates in current batch
        if (batchNames.has(name.toLowerCase())) {
            errors.push(`El nombre "${name}" está duplicado en este archivo`)
        } else {
            batchNames.add(name.toLowerCase())
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        data: errors.length === 0 ? data : null
    }
}

/**
 * Validate multiple catalog items
 * @param {Array} rows - Array of catalog item rows
 * @param {string} type - 'categories' or 'payment-terms'
 * @returns {Object} Validation result with validRows and invalidRows
 */
async function bulkValidateCatalogs(rows, type, companyId, importOptions = {}) {
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
        return {
            validRows: [],
            invalidRows: [],
            totals: { total: 0, valid: 0, invalid: 0 }
        }
    }

    // Fetch existing names from database
    const model = type === 'categories' ? prisma.productCategory : prisma.paymentTerm
    const existing = await model.findMany({
        where: { deleted: false, company_id: companyId },
        select: { name: true }
    })
    const existingNames = new Set(existing.map(item => item.name.toLowerCase()))

    // Track names in current batch to detect duplicates
    const batchNames = new Set()
    const matchName = nameMatcher(existing)
    const skips = rowSet(importOptions, 'skipRowIndexes')
    const skippedRows = []

    const validRows = []
    const invalidRows = []

    rows.forEach((row, index) => {
        const rowIndex = index + 1 // 1-based for user display
        if (skips.has(rowIndex)) { skippedRows.push({ rowIndex, reason: 'Omitida por el usuario' }); return }
        const validation = validateCatalogRow(row, rowIndex, type, existingNames, batchNames)
        validation.rowIndex = rowIndex
        checkSimilarity(validation, cell(row, ['nombre', 'name', 'nombre_categoria', 'nombre_termino']), matchName, importOptions, 1)

        if (validation.valid && validation.data) {
            validRows.push({
                rowIndex,
                data: validation.data
            })
        } else {
            invalidRows.push({
                rowIndex,
                errors: validation.errors,
                canCreateAnyway: validation.canCreateAnyway,
                similarMatches: validation.similarMatches,
                data: row
            })
        }
    })

    return {
        validRows,
        invalidRows,
        skippedRows,
        totals: {
            total: rows.length,
            skipped: skippedRows.length,
            valid: validRows.length,
            invalid: invalidRows.length
        }
    }
}

/**
 * Bulk create catalog items
 * @param {Array} validRows - Array of validated catalog item rows
 * @param {string} type - 'categories' or 'payment-terms'
 * @returns {Object} Result with created count and skipped count
 */
async function bulkCreateCatalogs(validRows, type, companyId, onProgress = () => {}, isCancelled = () => false) {
    if (!validRows || validRows.length === 0) {
        return { created: 0, skipped: 0, errors: [] }
    }

    const model = type === 'categories' ? prisma.productCategory : prisma.paymentTerm
    let created = 0
    let skipped = 0
    const errors = []

    let processed = 0
    for (let start = 0; start < validRows.length; start += 50) {
      if (isCancelled()) throw new ImportCancelledError()
      const batch = validRows.slice(start, start + 50)
      try {
        const result = await model.createMany({
          data: batch.map(row => ({ name: row.data.name, company_id: companyId })),
          skipDuplicates: true,
        })
        created += result.count
        skipped += batch.length - result.count
        processed += batch.length
        onProgress({ processed, total: validRows.length, created, skipped })
        continue
      } catch (e) {
        // Preserve row-level errors if the database cannot accept a whole batch.
      }
      for (const row of batch) {
        if (isCancelled()) throw new ImportCancelledError()
        try {
            await model.create({
                data: {
                    name: row.data.name,
                    company_id: companyId
                }
            })
            created++
        } catch (e) {
            if (e.code === 'P2002') {
                // Unique constraint violation - duplicate name
                skipped++
            } else {
                errors.push({
                    rowIndex: row.rowIndex,
                    error: e.message || 'Error desconocido'
                })
            }
        }
        processed++
        onProgress({ processed, total: validRows.length, created, skipped })
      }
    }

    return { created, skipped, errors }
}

module.exports = {
    validateCatalogRow,
    bulkValidateCatalogs,
    bulkCreateCatalogs
}
