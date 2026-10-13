const bcrypt = require('bcryptjs')
const { prisma } = require('../../models/prisma')
const { fail } = require('../../services/userAccess')
const { ACCESS_COOKIE, REFRESH_COOKIE, accessCookieOptions, refreshCookieOptions } = require('../../config/security')
const handle = fn => async (req, res, next) => { try { await fn(req, res) } catch (e) { next(e) } }
exports.sessions = handle(async (req, res) => {
  const rows = await prisma.refreshToken.findMany({ where: { user_id: req.user.sub, revoked_at: null, expires_at: { gt: new Date() } }, orderBy: { created_at: 'desc' }, select: { session_id: true, device: true, created_at: true, expires_at: true } })
  res.json(rows.map(s => ({ id: s.session_id, device: s.device || 'Dispositivo no registrado', last_activity_at: s.created_at, expires_at: s.expires_at, current: s.session_id === req.user.sid })))
})
exports.closeSession = handle(async (req, res) => {
  const all = req.params.sessionId === 'all'
  const result = await prisma.refreshToken.updateMany({ where: { user_id: req.user.sub, ...(all ? {} : { session_id: req.params.sessionId }), revoked_at: null }, data: { revoked_at: new Date() } })
  if (!all && !result.count) fail(404, 'Sesión no encontrada')
  if (all) await prisma.user.update({ where: { id: req.user.sub }, data: { auth_version: { increment: 1 } } })
  res.json({ ok: true, current: all || req.params.sessionId === req.user.sid })
})
exports.updateSelf = handle(async (req, res) => {
  const { name } = req.body || {}
  if (Object.keys(req.body || {}).some(k => k !== 'name')) fail(400, 'Solo puedes actualizar tu nombre desde esta operación')
  if (typeof name !== 'string' || !name.trim() || name.length > 150) fail(400, 'Nombre inválido')
  await prisma.user.update({ where: { id: req.user.sub }, data: { name: name.trim() } })
  res.json({ ok: true })
})
exports.password = handle(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {}
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 10 || Buffer.byteLength(newPassword) > 72) fail(400, 'Contraseña inválida: mínimo 10 caracteres, máximo 72 bytes')
  const user = await prisma.user.findUnique({ where: { id: req.user.sub } })
  if (!user || !await bcrypt.compare(currentPassword, user.password)) fail(400, 'La contraseña actual no es correcta')
  const password = await bcrypt.hash(newPassword, 10)
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { password, password_changed_at: new Date(), auth_version: { increment: 1 } } }),
    prisma.refreshToken.updateMany({ where: { user_id: user.id, revoked_at: null }, data: { revoked_at: new Date() } }),
  ])
  res.clearCookie(ACCESS_COOKIE, { ...accessCookieOptions(), maxAge: undefined })
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined })
  res.json({ ok: true, signInRequired: true })
})
