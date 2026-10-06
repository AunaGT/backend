const { randomUUID } = require('node:crypto')
const { assertSupabase } = require('../../services/supabaseStorage')
const { validateDocumentFile } = require('./domain/documents')
const { fail } = require('./domain/validation')

const BUCKET = 'hr'
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const UUID_RE = new RegExp(`^${UUID}$`, 'i')
const PATH_RE = new RegExp(`^${UUID}/employees/${UUID}/${UUID}\\.(pdf|png|jpg)$`, 'i')
const unavailable = message => fail(503, message)

async function assertPrivateHrBucket() {
  let result
  try { result = await assertSupabase().storage.getBucket(BUCKET) }
  catch { unavailable('No se pudo verificar el almacenamiento privado de RRHH') }
  if (result.error || !result.data) unavailable('El bucket hr no está disponible; verifica su configuración')
  if (result.data.public !== false) unavailable('El bucket hr debe ser privado para proteger los expedientes')
}

async function uploadHrFile({ companyId, employeeId, file }) {
  if (!UUID_RE.test(companyId) || !UUID_RE.test(employeeId)) fail(400, 'El destino del archivo no es válido')
  const metadata = validateDocumentFile(file)
  await assertPrivateHrBucket()
  const path = `${companyId}/employees/${employeeId}/${randomUUID()}.${metadata.extension}`
  let result
  try {
    result = await assertSupabase().storage.from(BUCKET).upload(path, file.buffer, { upsert: false, contentType: metadata.mimeType, cacheControl: '0' })
  } catch { unavailable('No se pudo cargar el archivo del expediente; intenta de nuevo') }
  if (result.error || !result.data) unavailable('No se pudo cargar el archivo del expediente; intenta de nuevo')
  return { path, ...metadata }
}

async function signHrFile(path, { downloadName } = {}) {
  if (!PATH_RE.test(path)) fail(400, 'La ruta documental no es válida')
  if (downloadName !== undefined && (typeof downloadName !== 'string' || !downloadName.trim() || downloadName.length > 255 || /[\\/\x00-\x1f\x7f]/.test(downloadName))) fail(400, 'El nombre de descarga no es válido')
  await assertPrivateHrBucket()
  let result
  try { result = await assertSupabase().storage.from(BUCKET).createSignedUrl(path, 300, downloadName ? { download: downloadName } : {}) }
  catch { unavailable('No se pudo abrir el documento; intenta de nuevo') }
  if (result.error || !result.data?.signedUrl) unavailable('No se pudo abrir el documento; intenta de nuevo')
  return { url: result.data.signedUrl, expiresAt: new Date(Date.now() + 300000).toISOString() }
}

// Callers supply only objects created by their own failed operation, never stored versions.
async function removeNewHrFiles(paths) {
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !PATH_RE.test(path))) fail(400, 'Las rutas de limpieza no son válidas')
  if (!paths.length) return
  let result
  try { result = await assertSupabase().storage.from(BUCKET).remove([...new Set(paths)]) }
  catch { unavailable('No se pudo limpiar la carga incompleta del expediente') }
  if (result.error) unavailable('No se pudo limpiar la carga incompleta del expediente')
}

module.exports = { assertPrivateHrBucket, uploadHrFile, signHrFile, removeNewHrFiles }
