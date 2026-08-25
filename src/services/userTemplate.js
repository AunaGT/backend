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
 * User Template Generation Service
 * Generates Excel templates for user imports
 */
const XLSX = require('xlsx')
const { prisma } = require('../models/prisma')

/**
 * Generate Excel template with headers, example data, and roles sheet
 * @returns {Promise<Buffer>} Excel file buffer
 */
async function generateUserTemplate() {
    // Fetch roles from DB
    const roles = await prisma.role.findMany({
        select: { id: true, name: true },
        orderBy: { id: 'asc' }
    })

    const headers = [
        'nombre',
        'email',
        'password',
        'rol'
    ]

    const example = [
        'Juan Pérez',
        'juan.perez@ejemplo.com',
        'Password123!',
        roles[0]?.name || 'admin'
    ]

    const workbook = XLSX.utils.book_new()
    const worksheet = XLSX.utils.aoa_to_sheet([headers, example])

    // Set column widths
    worksheet['!cols'] = [
        { wch: 25 }, // nombre
        { wch: 30 }, // email
        { wch: 20 }, // password
        { wch: 15 }, // rol
    ]

    XLSX.utils.book_append_sheet(workbook, worksheet, 'Usuarios')

    // Roles sheet - list of valid roles
    const rolesData = [['ID', 'Nombre del Rol']]
    roles.forEach(role => {
        rolesData.push([role.id, role.name])
    })
    const rolesWs = XLSX.utils.aoa_to_sheet(rolesData)
    rolesWs['!cols'] = [{ wch: 10 }, { wch: 25 }]
    XLSX.utils.book_append_sheet(workbook, rolesWs, 'Roles')

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
    return buffer
}

module.exports = {
    generateUserTemplate
}
