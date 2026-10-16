/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 *
 * For licensing inquiries: GitHub @dpatzan2
 */

const { prisma, prismaTransaction } = require('../../models/prisma')
const { normalizeReturnPolicy, validateReturnPolicyInput } = require('../returns/domain')
const {settingRevisions,assertExpectedRevisions,setSettingsActor,writeSettings}=require('../../services/settingsRevision')
const {GENERAL_SETTING_KEYS,historyKeys}=require('./settingsKeys')
const sharp = require('sharp')
const { invalidateSystemConfigCache } = require('../../utils/getTimezone')
const { fetchLogoForHttp } = require('../../utils/pdfBranding')
const {
  uploadImageBuffer,
  removePublicObject,
  COMPANY_LOGO_BUCKET,
} = require('../../services/supabaseStorage')

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
    for (const row of rows.filter(row=>GENERAL_SETTING_KEYS.includes(row.key))) {
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
    settings['returns.policy'] = normalizeReturnPolicy(settings['returns.policy'])
    settings._revisions=settingRevisions(rows.filter(row=>GENERAL_SETTING_KEYS.includes(row.key)),GENERAL_SETTING_KEYS)
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
    const keys = ['timezone', 'currency_code', 'currency_name', 'company_name', 'company_logo_url', 'date_format', 'locale', 'cash_closure_max_diff_pct', 'vat_affiliation', 'iva_rate', 'default_experience_profile', 'sales_allow_credit', 'sales_show_fiscal_fields', 'sales_show_channels', 'inventory_services_enabled', 'fel_enabled']
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
      iva_rate: '12',
      default_experience_profile: 'CASHIER',
      sales_allow_credit: 'true',
      sales_show_fiscal_fields: 'true',
      sales_show_channels: 'true',
      inventory_services_enabled: 'false',
      fel_enabled:'false'
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
  let uploadedUrl,committed=false
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No se proporcionó ningún archivo' })
    }
    const expected=logoRevision(req)

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

    const imageUrl = uploadedUrl = await uploadImageBuffer({
      bucket: COMPANY_LOGO_BUCKET,
      file,
      pathPrefix: 'company',
    })
    const saved=await saveLogoReference(req,imageUrl,expected)
    committed=true
    const warning=saved.previous && saved.previous!==imageUrl ? await cleanupLogo(saved.previous) : undefined
    invalidateSystemConfigCache(req.companyId)
    res.json({ imageUrl, company_logo_url: imageUrl,_revisions:saved.revisions,warning })
  } catch (e) {
    if(uploadedUrl&&!committed){const warning=await cleanupLogo(uploadedUrl);if(warning)e.message+=` ${warning}`}
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
    const saved=await saveLogoReference(req,'',logoRevision(req))
    const warning=saved.previous?await cleanupLogo(saved.previous):undefined
    invalidateSystemConfigCache(req.companyId)
    res.json({ company_logo_url: '',_revisions:saved.revisions,warning })
  } catch (e) {
    if(e.status)return res.status(e.status).json({message:e.message})
    next(e)
  }
}

function logoRevision(req){
  const raw=req.body?.expectedRevision
  const value=typeof raw==='string'&&/^(0|[1-9]\d*)$/.test(raw)?Number(raw):raw
  assertExpectedRevisions({company_logo_url:true},raw===undefined?undefined:{company_logo_url:value})
  return value
}
async function cleanupLogo(url){
  try{if(await removePublicObject(url,COMPANY_LOGO_BUCKET)===false)throw Error('No eliminado')}
  catch{return 'No se pudo limpiar un archivo de logo en Storage. La referencia confirmada se conserva.'}
}
async function saveLogoReference(req,value,expected){
  return prismaTransaction.$transaction(async tx=>{
    await setSettingsActor(tx,{actorId:req.user?.sub,source:'company-logo'})
    const previous=await tx.systemSetting.findFirst({where:{company_id:req.companyId,key:'company_logo_url'}})
    const rows=await writeSettings(tx,{companyId:req.companyId,changes:{company_logo_url:{value,type:'string'}},expectedRevisions:{company_logo_url:expected}})
    await tx.company.update({where:{id:req.companyId},data:{logo_url:value||null}})
    return{previous:previous?.value?.trim(),revisions:settingRevisions(rows)}
  },{maxWait:15000,timeout:30000})
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
    const body = req.body
    const raw = body && Object.hasOwn(body, 'settings') ? body.settings : body
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return res.status(400).json({ message: 'Se requiere un objeto con las claves a actualizar' })
    }
    const {expectedRevisions:ignored,...payload}=raw

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
        const value = payload[daysKey]
        const n = Number(value)
        if (!['number', 'string'].includes(typeof value) || !Number.isSafeInteger(n) || n < 1) {
          return res.status(400).json({ message: `${daysKey} debe ser un entero ≥ 1` })
        }
        payload[daysKey] = String(n)
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

    if (
      payload.default_experience_profile !== undefined &&
      !['CASHIER', 'MANAGER', 'OWNER', 'ADVANCED'].includes(String(payload.default_experience_profile))
    ) {
      return res.status(400).json({ message: 'default_experience_profile no es válido' })
    }
    for (const boolKey of ['sales_allow_credit', 'sales_show_fiscal_fields', 'sales_show_channels', 'inventory_services_enabled', 'fel_enabled']) {
      if (payload[boolKey] !== undefined && !['true', 'false'].includes(String(payload[boolKey]).toLowerCase())) {
        return res.status(400).json({ message: `${boolKey} debe ser true o false` })
      }
    }
    if (payload['returns.policy'] !== undefined) {
      try { payload['returns.policy'] = validateReturnPolicyInput(payload['returns.policy']) }
      catch (error) { if (error.status === 400) return res.status(400).json({ message: error.message }); throw error }
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
      'fel_enabled',
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
      'default_experience_profile',
      'sales_allow_credit',
      'sales_show_fiscal_fields',
      'sales_show_channels',
      'inventory_services_enabled',
      'returns.policy',
    ])
    if(Object.keys(payload).some(key=>!allowedKeys.has(key)))return res.status(400).json({message:'La solicitud contiene una configuración no admitida.'})
    const changes=Object.fromEntries(Object.entries(payload).map(([key,value])=>[key,{value:typeof value==='object'?JSON.stringify(value):String(value),type:['cash_closure_denominations','returns.policy'].includes(key)?'json':'string'}]))
    assertExpectedRevisions(changes,body?.expectedRevisions)

    // La identidad de la empresa vive en dos lados: la fila Company (selector,
    // traslados, contabilidad) y estas claves (PDFs, membretes). Se espejan para
    // que editar la configuración no deje el selector mostrando el nombre viejo.
    const companyFields = {}
    if (payload.company_name !== undefined) companyFields.name = String(payload.company_name).slice(0, 150)
    if (payload.company_nit !== undefined) companyFields.tax_id = String(payload.company_nit).slice(0, 100)
    if (payload.company_address !== undefined) companyFields.address = String(payload.company_address)
    if (payload.company_logo_url !== undefined) companyFields.logo_url = String(payload.company_logo_url).slice(0, 500)
    const rows = await prismaTransaction.$transaction(async tx => {
      await setSettingsActor(tx,{actorId:req.user?.sub,source:'configuration'})
      await writeSettings(tx,{companyId:req.companyId,changes,expectedRevisions:body.expectedRevisions})
      if (Object.keys(companyFields).length > 0) {
        await tx.company.update({ where: { id: req.companyId }, data: companyFields })
      }
      return tx.systemSetting.findMany({ where: { company_id: req.companyId }, orderBy: { key: 'asc' } })
    }, { maxWait: 15_000, timeout: 30_000 })

    invalidateSystemConfigCache(req.companyId)

    const settings = {}
    for (const row of rows.filter(row=>GENERAL_SETTING_KEYS.includes(row.key))) {
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
    settings['returns.policy']=normalizeReturnPolicy(settings['returns.policy'])
    settings._revisions=settingRevisions(rows.filter(row=>GENERAL_SETTING_KEYS.includes(row.key)),GENERAL_SETTING_KEYS)
    res.json(settings)
  } catch (e) {
    if(e.status)return res.status(e.status).json({message:e.message})
    next(e)
  }
}

exports.history=async(req,res,next)=>{
  try{
    const page=Number(req.query?.page||1),pageSize=Number(req.query?.pageSize||10)
    if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)return res.status(400).json({message:'La página del historial no es válida.'})
    const allowed=historyKeys(req.user),requested=req.query?.keys?String(req.query.keys).split(','):allowed
    const keys=requested.filter(key=>allowed.includes(key)),where={company_id:req.companyId,key:{in:keys}}
    const [totalItems,items]=await Promise.all([prisma.settingAuditEvent.count({where}),prisma.settingAuditEvent.findMany({where,orderBy:[{created_at:'desc'},{id:'desc'}],skip:(page-1)*pageSize,take:pageSize})])
    const actorIds=[...new Set(items.map(item=>item.actor_id).filter(Boolean))]
    const actors=actorIds.length?await prisma.user.findMany({where:{id:{in:actorIds},user_companies:{some:{company_id:req.companyId}}},select:{id:true,name:true}}):[]
    const names=new Map(actors.map(actor=>[actor.id,actor.name]))
    res.json({items:items.map(item=>({...item,actor_name:names.get(item.actor_id)||null})),totalItems,totalPages:Math.max(1,Math.ceil(totalItems/pageSize)),page})
  }catch(error){next(error)}
}
