const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeDocumentType, assertRequiredDocuments, validateDocumentFile } = require('../src/modules/hr/domain/documents')
const file = (buffer, mimetype = 'application/pdf', originalname = 'DPI.pdf') => ({ buffer, mimetype, originalname, size: buffer.length })

test('requisitos vacíos e inactivos no bloquean el alta', () => {
  assert.doesNotThrow(() => assertRequiredDocuments([], []))
  assert.doesNotThrow(() => assertRequiredDocuments([{ id: 'dpi', active: false, required: true }], []))
})
test('requisito activo faltante identifica el documento', () => {
  assert.throws(() => assertRequiredDocuments([{ id: 'dpi', name: 'Identificación', active: true, required: true }], []), e => e.status === 422 && e.missingTypeIds[0] === 'dpi')
})
test('selecciones duplicadas no se aceptan', () => {
  assert.throws(() => assertRequiredDocuments([], ['dpi', 'dpi']), e => e.status === 400)
})
test('tipos tienen límites y valores estrictos, opcionales por defecto', () => {
  assert.deepEqual(normalizeDocumentType({ name: ' DPI ' }), { name: 'DPI', instructions: '', required: false, active: true, sort_order: 0 })
  for (const input of [{ name: ' ' }, { name: 'x'.repeat(101) }, { name: 'DPI', required: 'false' }, { name: 'DPI', active: 1 }, { name: 'DPI', sort_order: -1 }, { name: 'DPI', sort_order: 1.5 }, { name: 'DPI', instructions: 'x'.repeat(501) }]) {
    assert.throws(() => normalizeDocumentType(input), e => e.status === 400)
  }
})
test('firma de PDF, PNG y JPEG determina el tipo validado y hash', () => {
  for (const [buffer, mimetype, name, extension] of [[Buffer.from('%PDF-1.7\n'), 'application/pdf', 'DPI.pdf', 'pdf'], [Buffer.from([137,80,78,71,13,10,26,10,0]), 'image/png', 'DPI.png', 'png'], [Buffer.from([255,216,255,224]), 'image/jpeg', 'DPI.jpg', 'jpg']]) {
    const result = validateDocumentFile(file(buffer, mimetype, name))
    assert.equal(result.extension, extension)
    assert.equal(result.mimeType, mimetype)
    assert.equal(result.size, buffer.length)
    assert.match(result.sha256, /^[a-f0-9]{64}$/)
  }
})
test('rechaza vacío, firma falsa, extensión falsa y nombre malicioso', () => {
  for (const value of [file(Buffer.alloc(0)), file(Buffer.from('plain text')), file(Buffer.from('%PDF-'), 'image/png', 'file.png'), file(Buffer.from('%PDF-'), 'application/pdf', 'file.png'), file(Buffer.from('%PDF-'), 'application/pdf', '../../DPI.pdf'), file(Buffer.from('%PDF-'), 'application/pdf', 'DPI\r\n.pdf')]) {
    assert.throws(() => validateDocumentFile(value), e => e.status === 400)
  }
})
test('límite exacto permitido, excedido y tamaño declarado incoherente rechazados', () => {
  const buffer = Buffer.alloc(5 * 1024 * 1024); buffer.write('%PDF-')
  assert.equal(validateDocumentFile(file(buffer)).size, buffer.length)
  assert.throws(() => validateDocumentFile(file(Buffer.concat([buffer, Buffer.from('x')]))), e => e.status === 413)
  assert.throws(() => validateDocumentFile({ ...file(buffer), size: 1 }), e => e.status === 400)
})
