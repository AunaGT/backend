const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { openImportStream, runImportStream, ImportCancelledError } = require('../src/utils/importStream')

test('emite progreso antes del resultado y detecta desconexión', () => {
  const res = new EventEmitter()
  const chunks = []
  const headers = {}
  res.setHeader = (key, value) => { headers[key] = value }
  res.flushHeaders = () => {}
  let flushes = 0
  res.flush = () => { flushes++ }
  res.write = (chunk) => { chunks.push(chunk) }
  res.end = () => { res.emit('finish') }

  const stream = openImportStream(res)
  stream.emit('phase', { phase: 'validating', processed: 0, total: 2 })
  stream.emit('progress', { phase: 'saving', processed: 1, total: 2 })
  assert.equal(chunks.length, 2)
  assert.equal(flushes, 2)
  stream.emit('complete', { phase: 'complete', processed: 2, total: 2, result: { created: 2 } })
  stream.end()

  assert.equal(headers['Content-Type'], 'text/event-stream; charset=utf-8')
  assert.deepEqual(chunks.map((chunk) => JSON.parse(chunk.slice(6))), [
    { type: 'phase', phase: 'validating', processed: 0, total: 2 },
    { type: 'progress', phase: 'saving', processed: 1, total: 2 },
    { type: 'complete', phase: 'complete', processed: 2, total: 2, result: { created: 2 } },
  ])
  assert.equal(stream.emit('progress', { processed: 3 }), false)
  res.emit('close')
  assert.equal(stream.cancelled(), true)
  assert.equal(new ImportCancelledError().name, 'ImportCancelledError')
})

test('reporta avance confirmado si el guardado falla después de algunas filas', async () => {
  const res = new EventEmitter()
  const chunks = []
  res.setHeader = () => {}
  res.flushHeaders = () => {}
  res.write = chunk => chunks.push(JSON.parse(chunk.slice(6)))
  res.end = () => {}
  await runImportStream(res, {
    total: 3,
    validate: async () => ({ validRows: [1, 2, 3], invalidRows: [] }),
    save: async (_rows, onProgress) => {
      onProgress({ processed: 2, total: 3, created: 2, skipped: 0 })
      throw new Error('database unavailable')
    },
  })
  assert.equal(chunks.at(-1).type, 'error')
  assert.equal(chunks.at(-1).processed, 2)
  assert.match(chunks.at(-1).message, /2 filas procesadas/)
})

test('no guarda cuando la revalidación detecta filas inválidas', async () => {
  const res = new EventEmitter()
  const chunks = []
  res.setHeader = () => {}
  res.flushHeaders = () => {}
  res.write = (chunk) => chunks.push(JSON.parse(chunk.slice(6)))
  res.end = () => {}
  let saved = false
  await runImportStream(res, {
    total: 2,
    validate: async () => ({ validRows: [{ rowIndex: 1 }], invalidRows: [{ rowIndex: 2, errors: ['Invalida'] }] }),
    save: async () => { saved = true },
  })
  assert.equal(saved, false)
  assert.equal(chunks.at(-1).type, 'error')
  assert.deepEqual(chunks.at(-1).invalidRows, [{ rowIndex: 2, errors: ['Invalida'] }])
})
