const { hasPerm, branchWhere, requireBranch } = require('../../middlewares/tenant')
const fail = (status, message) => { throw Object.assign(new Error(message), { status }) }

async function reviewClosure(db, req, { signature = false } = {}) {
  if (!req.user?.sub) fail(401, 'No autenticado')
  if (!hasPerm(req.user, 'cashclosure.validate') && (signature || !hasPerm(req.user, 'cashclosure.approve'))) fail(403, 'No tienes permiso para revisar arqueos')
  requireBranch(req)
  const body = req.body || {}
  if (!body.expectedUpdatedAt) fail(428, 'Recarga el arqueo antes de revisarlo')
  const version = new Date(body.expectedUpdatedAt)
  if (typeof body.expectedUpdatedAt !== 'string' || !Number.isFinite(+version)) fail(400, 'Versión del arqueo inválida')
  return db.$transaction(async tx => {
    await require('./reviewFlow').assertLegacyReview(tx, req.params.id)
    const closure = await tx.cashClosure.findFirst({ where: { id: req.params.id, ...branchWhere(req) } })
    if (!closure) fail(404, 'Cierre no encontrado')
    if (closure.status !== 'Pendiente') fail(409, 'Este arqueo ya fue revisado. No puede reabrirse ni modificarse; recarga la información.')
    if (+closure.updated_at !== +version) fail(409, 'El arqueo cambió desde que lo abriste. Recarga antes de revisarlo.')
    const updatedAt = new Date(Math.max(Date.now(), +closure.updated_at + 1))
    const data = { updated_at: updatedAt }
    if (signature) {
      if (typeof body.supervisorSignature !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(body.supervisorSignature) || body.supervisorSignature.length > 300000) fail(400, 'Ingresa una firma PNG válida de hasta 300 KB')
      Object.assign(data, { supervisor_signature: body.supervisorSignature, supervisor_id: req.user.sub, supervisor_name: req.user.name || 'Supervisor', supervisor_validated_at: updatedAt })
    } else {
      if (!['Aprobado', 'Rechazado'].includes(body.status)) fail(400, 'Solo puedes aprobar o rechazar un arqueo pendiente')
      data.status = body.status
      if (closure.supervisor_id !== req.user.sub) data.supervisor_signature = null
      if (body.status === 'Rechazado') {
        if (typeof body.rejection_reason !== 'string' || !body.rejection_reason.trim() || body.rejection_reason.length > 2000) fail(400, 'Indica un motivo de rechazo de hasta 2000 caracteres')
        data.notes = [closure.notes, `--- RECHAZADO ---\nRazón: ${body.rejection_reason.trim()}\nFecha: ${updatedAt.toISOString()}\nRevisado por: ${req.user.sub}`].filter(Boolean).join('\n\n')
      }
      Object.assign(data, { supervisor_id: req.user.sub, supervisor_name: req.user.name || 'Supervisor', supervisor_validated_at: updatedAt })
    }
    const changed = await tx.cashClosure.updateMany({ where: { id: closure.id, ...branchWhere(req), status: 'Pendiente', updated_at: version }, data })
    if (changed.count !== 1) fail(409, 'Otro encargado ya revisó o modificó este arqueo. Recarga la información.')
    const reviewed = await tx.cashClosure.findUnique({ where: { id: closure.id }, include: { payment_breakdowns: { include: { payment_method: true } }, denominations: true, cash_register_session: { select: { id: true, opening_float: true, opened_at: true, closed_at: true, cashRegister: { select: { id: true, name: true, code: true } } } } } })
    return (await require('./snapshots').hydrateClosureSnapshots(tx, [reviewed]))[0]
  })
}

module.exports = { reviewClosure }
