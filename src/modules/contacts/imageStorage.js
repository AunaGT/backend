const { randomUUID } = require('node:crypto')
const sharp = require('sharp')
const { assertSupabase } = require('../../services/supabaseStorage')

const BUCKET = 'contacts'
const MAX_BYTES = 5 * 1024 * 1024
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const UUID_RE = new RegExp(`^${UUID}$`, 'i')
const PATH_RE = new RegExp(`^${UUID}/contacts/${UUID}/${UUID}\\.webp$`, 'i')
const fail = (status, message) => Object.assign(new Error(message), { status })

function ownsImage(path, companyId, contactId) {
  return typeof path === 'string' && PATH_RE.test(path) && path.startsWith(`${companyId}/contacts/${contactId}/`)
}

async function uploadContactImage(companyId, contactId, file) {
  if (!UUID_RE.test(companyId) || !UUID_RE.test(contactId)) throw fail(400, 'El contacto de destino no es válido')
  if (!file?.buffer?.length) throw fail(400, 'Selecciona una imagen')
  if (file.buffer.length > MAX_BYTES) throw fail(413, 'La imagen admite hasta 5 MB')
  const formats = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }
  if (!formats[file.mimetype]) throw fail(400, 'Selecciona una imagen JPG, PNG o WebP')
  let buffer
  try {
    const image = sharp(file.buffer, { limitInputPixels: 20000000, failOn: 'warning' })
    const metadata = await image.metadata()
    if (metadata.format !== formats[file.mimetype] || (metadata.pages ?? 1) !== 1) throw Error('Formato no válido')
    // Normalizar elimina metadatos personales y evita servir archivos disfrazados de imagen.
    buffer = await image.rotate().resize(800, 800, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer()
  } catch { throw fail(400, 'La imagen está dañada, es animada o supera las dimensiones admitidas') }

  const path = `${companyId}/contacts/${contactId}/${randomUUID()}.webp`
  try {
    const { data, error } = await assertSupabase().storage.from(BUCKET).upload(path, buffer, { upsert: false, contentType: 'image/webp', cacheControl: '0' })
    if (error || !data) throw error || Error('Sin confirmación')
  } catch { throw fail(503, 'No se pudo guardar la imagen del contacto. Intenta nuevamente.') }
  return path
}

async function contactImageDtos(contacts, companyId) {
  const paths = [...new Set(contacts.filter(contact => ownsImage(contact.image_storage_path, companyId, contact.id)).map(contact => contact.image_storage_path))]
  let signed = new Map()
  if (paths.length) {
    try {
      const { data, error } = await assertSupabase().storage.from(BUCKET).createSignedUrls(paths, 3600)
      if (error) throw error
      signed = new Map((data ?? []).filter(item => !item.error && item.signedUrl).map(item => [item.path, item.signedUrl]))
    } catch { console.warn('[contact-images] No se pudieron firmar las fotos; se usará la imagen predeterminada') }
  }
  return contacts.map(({ image_storage_path: path, ...contact }) => ({ ...contact, image_url: ownsImage(path, companyId, contact.id) ? signed.get(path) ?? null : null }))
}

async function removeContactImage(path, companyId, contactId) {
  if (!ownsImage(path, companyId, contactId)) return
  const { error } = await assertSupabase().storage.from(BUCKET).remove([path])
  if (error) throw fail(503, 'No se pudo limpiar la imagen reemplazada')
}

module.exports = { uploadContactImage, contactImageDtos, removeContactImage }
