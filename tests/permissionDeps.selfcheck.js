/**
 * Las dependencias de permisos no dependen de la base: solo del mapa.
 * Uso: node tests/permissionDeps.selfcheck.js
 */
const assert = require('assert')
const { IMPLIES, expandPermissions } = require('../src/config/permissionDeps')

// 1. Marcar el de gestión trae el de ver.
assert.deepStrictEqual(
  expandPermissions(['warehouses.manage']).sort(),
  ['warehouses.manage', 'warehouses.view']
)

// 2. En cascada: ajustar → ver movimientos → ver almacenes (y ver productos).
const ajuste = expandPermissions(['stock_moves.adjust'])
for (const code of ['stock_moves.view', 'warehouses.view', 'products.view']) {
  assert.ok(ajuste.includes(code), `stock_moves.adjust debe arrastrar ${code}`)
}

// 3. No inventa permisos: lo que no arrastra nada se queda solo.
assert.deepStrictEqual(expandPermissions(['analytics.view']), ['analytics.view'])

// 4. Idempotente y sin duplicados.
const dos = expandPermissions(['products.edit', 'products.edit', 'products.view'])
assert.strictEqual(new Set(dos).size, dos.length)
assert.deepStrictEqual(expandPermissions(dos).sort(), dos.sort())

// 5. Todo lo que se arrastra existe como permiso real (nada de códigos muertos).
const seed = require('fs').readFileSync(require('path').join(__dirname, '../prisma/seed.js'), 'utf8')
const reales = new Set([...seed.matchAll(/code: '([^']+)'/g)].map((m) => m[1]))
for (const permission of require('../scripts/register-appointments-permissions').permissions) reales.add(permission.code)
for (const [code, deps] of Object.entries(IMPLIES)) {
  assert.ok(reales.has(code), `${code} no existe en el seed`)
  for (const dep of deps) assert.ok(reales.has(dep), `${code} arrastra ${dep}, que no existe`)
}

// 6. Ningún ciclo cuelga la expansión (el mapa entero termina).
assert.ok(expandPermissions(Object.keys(IMPLIES)).length > 0)

console.log('permissionDeps.selfcheck OK')
