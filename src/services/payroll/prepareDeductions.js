const { setSettingsActor, writeSettings } = require('../settingsRevision')
const KEY = 'accounting.defaultAccounts'
const NAME = 'Descuentos de nómina por conciliar'

async function prepareDeductions(tx, companyId, actorId = null) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(910008, hashtext(${companyId}))`
  const setting = await tx.systemSetting.findUnique({ where: { company_id_key: { company_id: companyId, key: KEY } } })
  let map = {}
  try { if (setting) map = JSON.parse(setting.value) } catch { return { configured: false, conflict: 'Revisa el mapeo contable: no contiene un JSON válido' } }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return { configured: false, conflict: 'El mapeo contable debe ser un objeto' }
  const code = map.payrollOtherDeductions || '2108'
  const account = await tx.account.findFirst({ where: { company_id: companyId, code } })
  if (map.payrollOtherDeductions) {
    const valid = account?.active && !account.is_group && account.type === 'LIABILITY'
    return { configured: !!valid, conflict: valid ? null : `Revisa la cuenta ${code} configurada para descuentos de nómina` }
  }
  if (account && (account.name !== NAME || account.type !== 'LIABILITY' || account.is_group || !account.active)) {
    return { configured: false, conflict: 'La cuenta 2108 ya tiene otro uso. Configura payrollOtherDeductions con una cuenta de pasivo disponible.' }
  }
  if (!account) {
    const parent = await tx.account.findFirst({ where: { company_id: companyId, code: '2', type: 'LIABILITY', is_group: true, active: true } })
    await tx.account.create({ data: { company_id: companyId, code, name: NAME, type: 'LIABILITY', system: true, active: true, is_group: false, parent_id: parent?.id || null } })
  }
  await setSettingsActor(tx, { actorId, source: 'payroll-deductions-preparation' })
  await writeSettings(tx, { companyId, changes: { [KEY]: { value: JSON.stringify({ ...map, payrollOtherDeductions: code }), type: 'json' } }, expectedRevisions: { [KEY]: setting?.revision || 0 } })
  return { configured: true, conflict: null }
}
module.exports = { prepareDeductions }
