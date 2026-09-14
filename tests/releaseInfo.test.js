const test = require('node:test')
const assert = require('node:assert/strict')

const { getReleaseInfo } = require('../src/config/release')

test('release info identifica commit y rama de Vercel sin exponer otras variables', () => {
  const release = getReleaseInfo({
    VERCEL_GIT_COMMIT_SHA: '3271b48c368589c2c56176232ca666fb3b0d4566',
    VERCEL_GIT_COMMIT_REF: 'Modularizado',
    DATABASE_URL: 'no-debe-aparecer',
  })

  assert.deepEqual(release, {
    version: '1.0.0',
    commit: '3271b48c3685',
    branch: 'Modularizado',
  })
})

test('release info conserva valores nulos fuera de un despliegue', () => {
  assert.deepEqual(getReleaseInfo({}), {
    version: '1.0.0',
    commit: null,
    branch: null,
  })
})
