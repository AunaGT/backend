const { randomUUID } = require('node:crypto')
const { assertSupabase } = require('../../services/supabaseStorage')
const { validateDocumentFile } = require('../hr/domain/documents')
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
const BUCKET = 'cash-evidence'
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const PATH_RE = new RegExp(`^${UUID}/notices/${UUID}\\.(pdf|png|jpg)$`, 'i')

// El bucket lo crea el dueño en Supabase; sin él (o si fuera público) la carga queda desactivada, no se expone nada.
async function evidenceAvailable() {
  try { const { data, error } = await assertSupabase().storage.getBucket(BUCKET); return !error && !!data && data.public === false } catch { return false }
}
// El prefijo lo arma quien llama (avisos o un expediente); aquí solo se valida el archivo y se guarda sin sobrescribir.
async function storeEvidence(prefix, file) {
  const metadata = validateDocumentFile(file)
  if (!await evidenceAvailable()) fail(503, 'CASH_EVIDENCE_UNAVAILABLE', 'El almacenamiento privado de evidencias no está disponible. Usa el identificador verificable.')
  const path = `${prefix}/${randomUUID()}.${metadata.extension}`
  let result
  try { result = await assertSupabase().storage.from(BUCKET).upload(path, file.buffer, { upsert: false, contentType: metadata.mimeType, cacheControl: '0' }) } catch { result = null }
  if (!result || result.error) fail(503, 'CASH_EVIDENCE_UNAVAILABLE', 'No se pudo cargar la evidencia; intenta de nuevo')
  return { path, mimeType: metadata.mimeType, size: metadata.size }
}
const uploadEvidence = (companyId, file) => storeEvidence(`${companyId}/notices`, file)
// Descarga con URL firmada corta y solo de una ruta de la propia empresa.
async function signEvidence(companyId, path) {
  if (typeof path !== 'string' || !PATH_RE.test(path) || !path.startsWith(`${companyId}/notices/`)) fail(404, 'CASH_EVIDENCE_NOT_FOUND', 'Evidencia no encontrada')
  return signStoredEvidence(path)
}
// Firma una ruta ya verificada por quien llama contra su propio documento.
async function signStoredEvidence(path) {
  let result
  try { result = await assertSupabase().storage.from(BUCKET).createSignedUrl(path, 60) } catch { result = null }
  if (!result || result.error || !result.data?.signedUrl) fail(503, 'CASH_EVIDENCE_UNAVAILABLE', 'No se pudo abrir la evidencia; intenta de nuevo')
  return { url: result.data.signedUrl, expiresAt: new Date(Date.now() + 60000).toISOString() }
}
module.exports = { evidenceAvailable, uploadEvidence, signEvidence, storeEvidence, signStoredEvidence }
