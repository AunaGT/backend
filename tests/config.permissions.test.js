const test = require('node:test'), assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
test('settings route admits read or manage while mutations still require manage', async () => {
  const routes = [], router = Object.fromEntries(['get', 'patch', 'post', 'delete', 'put', 'use'].map(method => [method, (path, ...handlers) => routes.push({ method, path, handlers })]))
  const auth = require('../src/middlewares/autenticacion'), target = require.resolve('../src/modules/config/routes')
  await withMocks({ [require.resolve('express')]: { Router: () => router }, [require.resolve('../src/middlewares/autenticacion')]: { ...auth, Auth() {} }, [require.resolve('../src/modules/config/controller')]: {} }, target, () => {
    function allowed(method, path, permissions, role = { id: 61, name: 'Personalizado' }) {
      const res = { ...jsonResponse(), send(value) { this.body = value; return this } }; let passed = false
      routes.find(r => r.method === method && r.path === path).handlers[1]({ user: permissions === null ? null : { role, permissions } }, res, () => { passed = true })
      return passed
    }
    assert.equal(allowed('get', '/', ['settings.manage']), true)
    assert.equal(allowed('get', '/', ['settings.view']), true)
    assert.equal(allowed('get', '/', []), false); assert.equal(allowed('get', '/', null), false)
    assert.equal(allowed('get', '/', [], { id: 1, name: 'admin', system_key: 'ADMIN', company_id: null }), true)
    for (const [method, path] of [['patch', '/'], ['post', '/upload-logo'], ['delete', '/logo']]) {
      assert.equal(allowed(method, path, ['settings.view']), false)
      assert.equal(allowed(method, path, ['settings.manage']), true)
    }
  })
})
