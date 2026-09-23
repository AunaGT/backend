const { prisma } = require('../../models/prisma')
const {
  ACTIVE_STATUSES,
  MODULE_DEFINITIONS,
  getModuleDefinition,
  resolveEffectiveModules,
} = require('./registry')

const CACHE_TTL_MS = 30_000
const cache = new Map()

function invalidateCompanyModules(companyId) {
  cache.delete(companyId)
}

async function readCompanyModules(companyId, client = prisma, { useCache = true } = {}) {
  const cached = cache.get(companyId)
  if (useCache && cached && cached.expiresAt > Date.now()) return cached.modules

  const rows = await client.companyModule.findMany({
    where: { company_id: companyId },
    orderBy: { module_code: 'asc' },
  })
  const modules = resolveEffectiveModules(rows)
  if (client === prisma) {
    cache.set(companyId, { modules, expiresAt: Date.now() + CACHE_TTL_MS })
  }
  return modules
}

async function getCompanyModuleBlock(companyId, code, loadModules = readCompanyModules) {
  const modules = await loadModules(companyId, undefined, { useCache: false })
  const module = modules?.find((item) => item.code === code)
  if (module?.effectiveEnabled) return null
  return {
    code: 'MODULE_DISABLED',
    message: `El módulo ${module?.name || code} no está disponible para esta empresa`,
    module: code,
    status: module?.status || 'DISABLED',
    blockedBy: module?.blockedBy || [],
  }
}

async function seedCompanyModules(client, companyId) {
  await client.companyModule.createMany({
    data: MODULE_DEFINITIONS.map((module) => ({
      company_id: companyId,
      module_code: module.code,
      status: 'ACTIVE',
      activated_at: new Date(),
    })),
    skipDuplicates: true,
  })
}

async function updateCompanyModule(companyId, code, input) {
  const definition = getModuleDefinition(code)
  if (!definition) {
    const error = new Error(`Módulo desconocido: ${code}`)
    error.status = 404
    throw error
  }

  const allowedStatuses = ['ACTIVE', 'TRIAL', 'SUSPENDED', 'DISABLED']
  const status = input?.status ? String(input.status).toUpperCase() : undefined
  if (status && !allowedStatuses.includes(status)) {
    const error = new Error(`Estado inválido. Usa: ${allowedStatuses.join(', ')}`)
    error.status = 400
    throw error
  }
  if (definition.protected && status && !ACTIVE_STATUSES.has(status)) {
    const error = new Error(`${definition.name} es un módulo base y no se puede desactivar`)
    error.status = 409
    error.code = 'PROTECTED_MODULE'
    throw error
  }

  let trialEndsAt
  if (input?.trialEndsAt !== undefined && input.trialEndsAt !== null && input.trialEndsAt !== '') {
    trialEndsAt = new Date(input.trialEndsAt)
    if (Number.isNaN(trialEndsAt.getTime())) {
      const error = new Error('trialEndsAt no es una fecha válida')
      error.status = 400
      throw error
    }
  } else if (input?.trialEndsAt === null || input?.trialEndsAt === '') {
    trialEndsAt = null
  }

  const current = await readCompanyModules(companyId, prisma, { useCache: false })
  if (status && ACTIVE_STATUSES.has(status)) {
    const unavailable = definition.dependencies.filter((dependency) =>
      !current.find((module) => module.code === dependency)?.effectiveEnabled
    )
    if (unavailable.length > 0) {
      const error = new Error(`Activa primero los módulos requeridos: ${unavailable.join(', ')}`)
      error.status = 409
      error.code = 'MODULE_DEPENDENCY_REQUIRED'
      throw error
    }
  }

  const data = {}
  if (status) {
    data.status = status
    data.activated_at = ACTIVE_STATUSES.has(status) ? new Date() : undefined
    data.suspended_at = status === 'SUSPENDED' ? new Date() : null
  }
  if (trialEndsAt !== undefined) data.trial_ends_at = trialEndsAt
  if (input?.config !== undefined) {
    if (!input.config || typeof input.config !== 'object' || Array.isArray(input.config)) {
      const error = new Error('config debe ser un objeto JSON')
      error.status = 400
      throw error
    }
    data.config = input.config
  }

  await prisma.companyModule.upsert({
    where: { company_id_module_code: { company_id: companyId, module_code: definition.code } },
    update: data,
    create: {
      company_id: companyId,
      module_code: definition.code,
      status: status || 'ACTIVE',
      config: input?.config || {},
      trial_ends_at: trialEndsAt || null,
      activated_at: !status || ACTIVE_STATUSES.has(status) ? new Date() : null,
      suspended_at: status === 'SUSPENDED' ? new Date() : null,
    },
  })
  invalidateCompanyModules(companyId)
  return readCompanyModules(companyId, prisma, { useCache: false })
}

module.exports = {
  getCompanyModuleBlock,
  invalidateCompanyModules,
  readCompanyModules,
  seedCompanyModules,
  updateCompanyModule,
}
