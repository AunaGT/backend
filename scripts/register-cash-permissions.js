const { permissions, movementPermissions, custodyPermissions, policyPermissions, noticePermissions, settlementPermissions, dailyPermissions, closureReadPermissions, correctionPermissions, disputePermissions } = require('../src/modules/cash-closure/permissions')
async function registerSubset(db, definitions) {
  return db.$transaction(async tx => {
    const admin = await tx.role.findUnique({ where: { system_key: 'ADMIN' } })
    if (!require('../src/modules/users/roles/policy').isSystemAdmin(admin)) throw Error('Falta el admin global protegido')
    const rows = []
    for (const permission of definitions) rows.push(await tx.permission.upsert({ where: { code: permission.code }, create: permission, update: { name: permission.name, description: permission.description } }))
    await tx.rolePermission.createMany({ data: rows.map(row => ({ role_id: admin.id, permission_id: row.id })), skipDuplicates: true })
    return { permissions: rows.length, adminRoleId: admin.id }
  })
}
const registerCashPermissionsForAdmin = db => registerSubset(db, permissions)
const registerCashMovementPermissionsForAdmin = db => registerSubset(db, movementPermissions)
const registerCashCustodyPermissionsForAdmin = db => registerSubset(db, custodyPermissions)
const registerCashPolicyPermissionsForAdmin = db => registerSubset(db, policyPermissions)
const registerCashNoticePermissionsForAdmin = db => registerSubset(db, noticePermissions)
const registerCashSettlementPermissionsForAdmin = db => registerSubset(db, settlementPermissions)
const registerCashDailyPermissionsForAdmin = db => registerSubset(db, dailyPermissions)
const registerCashClosureReadPermissionsForAdmin = db => registerSubset(db, closureReadPermissions)
const registerCashCorrectionPermissionsForAdmin = db => registerSubset(db, correctionPermissions)
const registerCashDisputePermissionsForAdmin = db => registerSubset(db, disputePermissions)
if (require.main === module) {
  const mode = process.argv.slice(2).join(' ')
  if (!['--apply','--apply-movements','--apply-custody','--apply-review','--apply-notices','--apply-settlements','--apply-daily','--apply-closure-read','--apply-corrections','--apply-disputes'].includes(mode)) { console.error('Requiere un modo dirigido --apply-* y destino de desarrollo aprobado'); process.exitCode = 1 }
  else {
    require('../src/config/loadEnv')
    let db
    Promise.resolve().then(async () => {
      const url = process.env.DIRECT_URL || process.env.DATABASE_URL
      require('./salesDevTarget').approvedDevTarget(url)
      const { PrismaClient } = require('@prisma/client')
      db = new PrismaClient({ datasources: { db: { url } } })
      const result = await ({ '--apply': registerCashPermissionsForAdmin, '--apply-movements': registerCashMovementPermissionsForAdmin, '--apply-custody': registerCashCustodyPermissionsForAdmin, '--apply-review': registerCashPolicyPermissionsForAdmin, '--apply-notices': registerCashNoticePermissionsForAdmin, '--apply-settlements': registerCashSettlementPermissionsForAdmin, '--apply-daily': registerCashDailyPermissionsForAdmin, '--apply-closure-read': registerCashClosureReadPermissionsForAdmin, '--apply-corrections':registerCashCorrectionPermissionsForAdmin })[mode](db)
      console.log(`${result.permissions} permisos de cajas registrados solo para el admin global protegido`)
    }).catch(() => { console.error('No se registraron permisos de cajas. Revisa destino y admin canónico.'); process.exitCode = 1 }).finally(() => db?.$disconnect())
  }
}
module.exports = { registerCashPermissionsForAdmin, registerCashMovementPermissionsForAdmin, registerCashCustodyPermissionsForAdmin, registerCashPolicyPermissionsForAdmin, registerCashNoticePermissionsForAdmin, registerCashSettlementPermissionsForAdmin, registerCashDailyPermissionsForAdmin, registerCashClosureReadPermissionsForAdmin, registerCashCorrectionPermissionsForAdmin, registerCashDisputePermissionsForAdmin }
