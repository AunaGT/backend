const { createHash } = require('node:crypto')
const path = require('node:path')
const { fail } = require('./validation')

const MAX_FILE_SIZE = 5 * 1024 * 1024

function normalizeDocumentType(input = {}) {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const instructions = input.instructions == null ? '' : input.instructions
  if (!name || name.length > 100) fail(400, 'El nombre del documento es obligatorio y admite hasta 100 caracteres')
  if (typeof instructions !== 'string' || instructions.trim().length > 500) fail(400, 'Las instrucciones admiten hasta 500 caracteres')
  const required = input.required ?? false
  const active = input.active ?? true
  const sort_order = input.sort_order ?? 0
  if (typeof required !== 'boolean' || typeof active !== 'boolean') fail(400, 'Obligatorio y activo deben ser valores booleanos')
  if (!Number.isSafeInteger(sort_order) || sort_order < 0) fail(400, 'El orden debe ser un entero no negativo')
  return { name, instructions: instructions.trim(), required, active, sort_order }
}

function assertRequiredDocuments(types, selectedTypeIds) {
  const selected = new Set(selectedTypeIds)
  if (selected.size !== selectedTypeIds.length) fail(400, 'Solo se permite un archivo por tipo de documento')
  const missing = types.filter(type => type.active && type.required && !selected.has(type.id))
  if (missing.length) {
    const error = new Error(`Faltan documentos obligatorios: ${missing.map(type => type.name || type.id).join(', ')}`)
    error.status = 422
    error.missingTypeIds = missing.map(type => type.id)
    throw error
  }
}

function validateDocumentFile(file) {
  const buffer = file?.buffer
  if (!Buffer.isBuffer(buffer) || !buffer.length) fail(400, 'El archivo está vacío')
  if (buffer.length > MAX_FILE_SIZE) fail(413, 'Cada archivo admite hasta 5 MB')
  if (file.size !== buffer.length) fail(400, 'El tamaño del archivo no coincide con su contenido')
  const name = file.originalname
  if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(name)) fail(400, 'El nombre del archivo no es válido')
  let mimeType, extension
  if (buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) { mimeType = 'application/pdf'; extension = 'pdf' }
  else if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) { mimeType = 'image/png'; extension = 'png' }
  else if (buffer.subarray(0, 3).equals(Buffer.from([255,216,255]))) { mimeType = 'image/jpeg'; extension = 'jpg' }
  else fail(400, 'Solo se permiten archivos PDF, JPEG o PNG válidos')
  const suffix = path.extname(name).slice(1).toLowerCase()
  if (file.mimetype !== mimeType || !(extension === 'jpg' ? ['jpg', 'jpeg'] : [extension]).includes(suffix)) fail(400, 'El contenido del archivo no coincide con su tipo o extensión')
  return { mimeType, extension, size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') }
}

module.exports = { normalizeDocumentType, assertRequiredDocuments, validateDocumentFile, MAX_FILE_SIZE }
