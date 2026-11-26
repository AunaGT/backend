const test = require('node:test'), assert = require('node:assert/strict')
// El token viaja en una cookie httpOnly: el navegador descarta en silencio una cookie de más de 4096 bytes,
// y entonces toda petición protegida responde 401 aunque el login y el refresh funcionen.
test('the access token cookie stays far below the 4096-byte browser limit no matter how many permissions the role has', () => {
  const { crearToken } = require('../src/services/jwt'), { ACCESS_COOKIE } = require('../src/config/security')
  const permissions = Array.from({ length: 400 }, (_, i) => ({ permission: { code: `module.${i}.some_long_permission_code` } }))
  const user = { id: '22222222-2222-4222-8222-222222222222', name: 'Nombre muy largo de administración', email: 'admin.con.correo.largo@empresa.test', role_id: 1, auth_version: 3, role: { id: 1, name: 'admin', permissions } }
  const token = crearToken({ ...user, sid: '00000000-0000-4000-8000-000000000000' })
  assert.ok((ACCESS_COOKIE + '=' + token).length < 1024, `cookie de ${(ACCESS_COOKIE + '=' + token).length} bytes`)
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'))
  // El servidor solo usa estos campos: permisos, rol y datos personales se leen de la base en cada petición.
  assert.deepEqual(Object.keys(payload).sort(), ['auth_version', 'exp', 'iat', 'sid', 'sub'])
  assert.equal(payload.sub, user.id); assert.equal(payload.auth_version, 3)
})
