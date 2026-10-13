/**
 * Refresh tokens rotatorios, respaldados en DB. Se guarda sólo el hash SHA-256:
 * si se filtra la tabla, no se puede reconstruir el token.
 */

const crypto = require('crypto')
const { prisma } = require('../models/prisma.js')
const { REFRESH_TOKEN_DAYS } = require('../config/security')

function hash(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/** Crea un refresh token nuevo para el usuario y devuelve el valor en claro (va a la cookie). */
async function issue(userId, device) {
  const token = crypto.randomBytes(32).toString('hex')
  const expires_at = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000)
  await prisma.refreshToken.create({ data: { user_id: userId, token_hash: hash(token), expires_at, device: device?.slice(0, 200) } })
  return token
}

/**
 * Rota un refresh token: valida el viejo, lo revoca y emite uno nuevo.
 * Devuelve { userId, token } si es válido; null si no existe/expiró.
 * Si el token ya estaba revocado => posible robo: revoca TODAS las sesiones del usuario y devuelve { reuse: true }.
 */
async function rotate(oldToken) {
  const row = await prisma.refreshToken.findUnique({ where: { token_hash: hash(oldToken) } })
  if (!row) return null

  if (row.revoked_at) {
    // Reuso de un token ya rotado: alguien tiene una copia vieja. Cerrar todas las sesiones.
    await prisma.refreshToken.updateMany({
      where: { user_id: row.user_id, revoked_at: null },
      data: { revoked_at: new Date() },
    })
    return { reuse: true }
  }

  if (row.expires_at <= new Date()) return null

  const newToken = crypto.randomBytes(32).toString('hex')
  const expires_at = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000)
  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: row.id },
      data: { revoked_at: new Date(), replaced_by: hash(newToken) },
    }),
    prisma.refreshToken.create({
      data: { user_id: row.user_id, token_hash: hash(newToken), expires_at, session_id: row.session_id, device: row.device },
    }),
  ])
  return { userId: row.user_id, token: newToken, sessionId: row.session_id }
}

/** Revoca un refresh token puntual (logout). No falla si no existe. */
async function revoke(token) {
  if (!token) return
  await prisma.refreshToken.updateMany({
    where: { token_hash: hash(token), revoked_at: null },
    data: { revoked_at: new Date() },
  })
}

module.exports = { issue, rotate, revoke, hash }
