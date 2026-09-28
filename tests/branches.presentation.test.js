const test = require('node:test')
const assert = require('node:assert/strict')
const { branchState } = require('../src/modules/branches/presentation')

test('una sucursal inactiva no se presenta como operativa ni en mantenimiento', () => {
  assert.equal(branchState({ active: false, operational_status: 'MAINTENANCE' }), 'inactive')
})

test('mantenimiento se distingue de la activación de la sucursal', () => {
  assert.equal(branchState({ active: true, operational_status: 'MAINTENANCE' }), 'maintenance')
  assert.equal(branchState({ active: true, operational_status: 'OPERATING' }), 'operating')
})
