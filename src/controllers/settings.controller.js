/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 *
 * For licensing inquiries: GitHub @dpatzan2
 */

const { prisma } = require('../models/prisma')
const sharp = require('sharp')
const { invalidateSystemConfigCache } = require('../utils/getTimezone')
const { fetchLogoForHttp } = require('../utils/pdfBranding')
const {
  uploadImageBuffer,
  removePublicObject,
  COMPANY_LOGO_BUCKET,
} = require('../services/supabaseStorage')

/**
 * GET /api/settings
 * Devuelve todas las configuraciones (solo lectura; requiere settings.view)
 */
exports.getAll = async (req, res, next) => {
  try {
    const rows = await prisma.systemSetting.findMany({
      where: { company_id: req.companyId },
      orderBy: { key: 'asc' }
    })
    const settings = {}
    for (const row of rows) {
      if (row.type === 'json') {
        try {
          settings[row.key] = JSON.parse(row.value)
        } catch {
          settings[row.key] = row.value
        }
      } else {
        settings[row.key] = row.value
      }
    }
    res.json(settings)
  } catch (e) {
    next(e)
  }
}

/**
 * GET /api/settings/public
 * Devuelve timezone, currency, company_name, date_format, locale, cash_closure_max_diff_pct (cualquier usuario autenticado).
 */
exports.getPublic = async (req, res, next) => {
  try {
    const keys = ['timezone', 'currency_code', 'currency_name', 'company_name', 'company_logo_url', 'date_format', 'locale', 'cash_closure_max_diff_pct', 'vat_affiliation', 'iva_rate']
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: keys }, company_id: req.companyId }
    })
    const out = {
      timezone: 'America/Guatemala',
      currency_code: 'GTQ',
      currency_name: 'Quetzal',
      company_name: 'Auna',
      company_logo_url: '',
      date_format: 'dd/MM/yyyy',
      locale: 'es-GT',
      cash_closure_max_diff_pct: '5',
      vat_affiliation: '',
      iva_rate: '12'
    }
    for (const row of rows) {
      if (out.hasOwnProperty(row.key)) out[row.key] = (row.value != null && String(row.value).trim() !== '') ? String(row.value).trim() : out[row.key]
    }
    res.json(out)
  } catch (e) {
    next(e)
  }
}

/**
 * GET /api/settings/company-name
 * Nombre y logo públicos (login / cotización pública / branding sin auth).
 */
exports.getCompanyName = async (req, res, next) => {
  try {
    // Sin empresa resuelta (login, cotización pública) se responde el default:
    // servir el nombre y logo de una empresa cualquiera sería peor.
    if (!req.companyId) return res.json({ company_name: 'Auna', company_logo_url: '' })
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: ['company_name', 'company_logo_url'] }, company_id: req.companyId },
    })
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    const company_name = (map.company_name && String(map.company_name).trim()) || 'Auna'
    const company_logo_url = (map.company_logo_url && String(map.company_logo_url).trim()) || ''
    res.json({ company_name, company_logo_url })
  } catch (e) {
    next(e)
  }
}

/**
 * GET /api/settings/company-logo
 * Sirve el logo rasterizado (PNG/JPEG) para PDFs y favicon sin depender de CORS de Supabase.
 */
exports.getCompanyLogo = async (req, res, next) => {
  try {
    if (!req.companyId) return res.status(404).end()
    const row = await prisma.systemSetting.findFirst({ where: { key: 'company_logo_url', company_id: req.companyId } })
    const logoUrl = row?.value?.trim()
    if (!logoUrl) return res.status(404).end()

    const logo = await fetchLogoForHttp(logoUrl)
    if (!logo?.buffer?.length) return res.status(404).end()

    res.setHeader('Content-Type', logo.contentType)
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.send(logo.buffer)
  } catch (e) {
    next(e)
  }
}

/**
 * POST /api/settings/upload-logo
 * Sube logo al bucket Supabase "logo" y guarda company_logo_url.
 */
exports.uploadLogo = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No se proporcionó ningún archivo' })
    }

    let file = req.file
    const isSvg = file.mimetype === 'image/svg+xml' || file.mimetype === 'image/svg'
    const needsRaster =
      isSvg || file.mimetype === 'image/webp' || file.mimetype === 'image/avif'
    if (needsRaster) {
      const pngBuffer = await sharp(file.buffer, isSvg ? { density: 150 } : undefined)
        .png()
        .toBuffer()
      file = {
        ...file,
        buffer: pngBuffer,
        mimetype: 'image/png',
        size: pngBuffer.length,
        originalname: `${(file.originalname || 'logo').replace(/\.[^.]+$/, '')}.png`,
      }
    }

    const prev = await prisma.systemSetting.findFirst({ where: { key: 'company_logo_url', company_id: req.companyId } })
    const prevUrl = prev?.value?.trim()

    const imageUrl = await uploadImageBuffer({
      bucket: COMPANY_LOGO_BUCKET,
      file: req.file,
      pathPrefix: 'company',
    })

    await prisma.systemSetting.upsert({
      where: { company_id_key: { company_id: req.companyId, key: 'company_logo_url' } },
      update: { value: imageUrl, type: 'string' },
      create: {
        company_id: req.companyId,
        key: 'company_logo_url',
        value: imageUrl,
        type: 'string',
        description: 'URL pública del logo del negocio (bucket logo)',
      },
    })

    if (prevUrl && prevUrl !== imageUrl) {
      await removePublicObject(prevUrl, COMPANY_LOGO_BUCKET)
    }

    await prisma.company.update({ where: { id: req.companyId }, data: { logo_url: imageUrl } })
    invalidateSystemConfigCache(req.companyId)
    res.json({ imageUrl, company_logo_url: imageUrl })
  } catch (e) {
    if (e.status) return res.status(e.status).json({ message: e.message })
    next(e)
  }
}

/**
 * DELETE /api/settings/logo
 * Quita el logo configurado (opcionalmente borra el archivo en Storage).
 */
exports.removeLogo = async (req, res, next) => {
  try {
    const prev = await prisma.systemSetting.findFirst({ where: { key: 'company_logo_url', company_id: req.companyId } })
    const prevUrl = prev?.value?.trim()

    await prisma.systemSetting.upsert({
      where: { company_id_key: { company_id: req.companyId, key: 'company_logo_url' } },
      update: { value: '', type: 'string' },
      create: {
        company_id: req.companyId,
        key: 'company_logo_url',
        value: '',
        type: 'string',
        description: 'URL pública del logo del negocio (bucket logo)',
      },
    })

    if (prevUrl) {
      await removePublicObject(prevUrl, COMPANY_LOGO_BUCKET)
    }

    await prisma.company.update({ where: { id: req.companyId }, data: { logo_url: null } })
    invalidateSystemConfigCache(req.companyId)
    res.json({ company_logo_url: '' })
  } catch (e) {
    next(e)
  }
}

/**
 * GET /api/settings/denominations
 * Devuelve solo las denominaciones para cierre de caja (público para quien tenga settings.view o cashclosure)
 */
exports.getDenominations = async (req, res, next) => {
  try {
    const row = await prisma.systemSetting.findFirst({
      where: { key: 'cash_closure_denominations', company_id: req.companyId }
    })
    if (!row) {
      return res.json([])
    }
    try {
      const list = JSON.parse(row.value)
      const normalized = Array.isArray(list)
        ? list.map((d) => ({
            denomination: Number(d.denomination) || 0,
            type: d.type === 'Moneda' ? 'Moneda' : 'Billete',
            quantity: 0,
            subtotal: 0
          }))
        : []
      return res.json(normalized)
    } catch {
      return res.json([])
    }
  } catch (e) {
    next(e)
  }
}

/**
 * Valida cash_closure_denominations: array de { denomination (number > 0), type ('Billete'|'Moneda') }
 */
function validateDenominations (value) {
  if (!Array.isArray(value)) return 'Las denominaciones deben ser una lista'
  const validTypes = new Set(['Billete', 'Moneda'])
  for (let i = 0; i < value.length; i++) {
    const d = value[i]
    const num = Number(d?.denomination)
    if (!Number.isFinite(num) || num <= 0) {
      return `Denominación en posición ${i + 1}: el valor debe ser un número mayor que 0`
    }
    const t = d?.type === 'Moneda' ? 'Moneda' : (d?.type === 'Billete' ? 'Billete' : null)
    if (!t) return `Denominación en posición ${i + 1}: el tipo debe ser "Billete" o "Moneda"`
  }
  return null
}

/**
 * PATCH /api/settings
 * Actualiza una o varias configuraciones (requiere settings.manage)
 * Body: { key: value, ... } o { settings: { key: value, ... } }
 */
exports.update = async (req, res, next) => {
  try {
    const payload = req.body.settings || req.body
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ message: 'Se requiere un objeto con las claves a actualizar' })
    }

    if (payload.cash_closure_denominations !== undefined) {
      const err = validateDenominations(payload.cash_closure_denominations)
      if (err) return res.status(400).json({ message: err })
    }
    if (payload.currency_code !== undefined) {
      const v = String(payload.currency_code).trim()
      if (!v) return res.status(400).json({ message: 'El código de moneda no puede estar vacío' })
    }
    if (payload.timezone !== undefined) {
      const v = String(payload.timezone).trim()
      if (!v) return res.status(400).json({ message: 'La zona horaria no puede estar vacía' })
    }
    for (const daysKey of ['quote_validity_days', 'order_validity_days', 'quote_soft_hold_hours']) {
      if (payload[daysKey] !== undefined) {
        const n = parseInt(String(payload[daysKey]), 10)
        if (!Number.isFinite(n) || n < 1) {
          return res.status(400).json({ message: `${daysKey} debe ser un entero ≥ 1` })
        }
      }
    }
    for (const rateKey of ['iva_rate', 'pequeno_rate']) {
      if (payload[rateKey] !== undefined) {
        const n = Number(payload[rateKey])
        if (!Number.isFinite(n) || n < 0 || n >= 100) {
          return res.status(400).json({ message: `${rateKey} debe ser un número entre 0 y 99` })
        }
      }
    }

    const allowedKeys = new Set([
      'currency_code',
      'currency_name',
      'timezone',
      'company_name',
      'company_logo_url',
      'cash_closure_denominations',
      // Datos fiscales (Fase 3 / FEL)
      'company_nit',
      'company_address',
      'company_municipality',
      'company_department',
      'company_postal_code',
      'establishment_code',
      'vat_affiliation',
      'iva_rate',
      'pequeno_rate',
      'date_format',
      'locale',
      'cash_closure_max_diff_pct',
      'quote_validity_days',
      'order_validity_days',
      'quote_soft_hold_hours',
    ])

    for (const [key, value] of Object.entries(payload)) {
      if (!allowedKeys.has(key)) continue
      const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value)
      const type = key === 'cash_closure_denominations' ? 'json' : 'string'
      await prisma.systemSetting.upsert({
        where: { company_id_key: { company_id: req.companyId, key } },
        update: { value: valueStr, type },
        create: { company_id: req.companyId, key, value: valueStr, type }
      })
    }

    // La identidad de la empresa vive en dos lados: la fila Company (selector,
    // traslados, contabilidad) y estas claves (PDFs, membretes). Se espejan para
    // que editar la configuración no deje el selector mostrando el nombre viejo.
    const companyFields = {}
    if (payload.company_name !== undefined) companyFields.name = String(payload.company_name).slice(0, 150)
    if (payload.company_nit !== undefined) companyFields.tax_id = String(payload.company_nit).slice(0, 100)
    if (payload.company_address !== undefined) companyFields.address = String(payload.company_address)
    if (payload.company_logo_url !== undefined) companyFields.logo_url = String(payload.company_logo_url).slice(0, 500)
    if (Object.keys(companyFields).length > 0) {
      await prisma.company.update({ where: { id: req.companyId }, data: companyFields })
    }

    invalidateSystemConfigCache(req.companyId)

    const rows = await prisma.systemSetting.findMany({ where: { company_id: req.companyId }, orderBy: { key: 'asc' } })
    const settings = {}
    for (const row of rows) {
      if (row.type === 'json') {
        try {
          settings[row.key] = JSON.parse(row.value)
        } catch {
          settings[row.key] = row.value
        }
      } else {
        settings[row.key] = row.value
      }
    }
    res.json(settings)
  } catch (e) {
    next(e)
  }
}
