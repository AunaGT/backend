/**
 * Utilidades para Supabase Storage (subida / borrado desde el backend).
 */

const { createClient } = require('@supabase/supabase-js')

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase =
  supabaseUrl && supabaseServiceKey ? createClient(supabaseUrl, supabaseServiceKey) : null

function assertSupabase() {
  if (!supabase) {
    const err = new Error('Supabase no configurado. Verifica SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en .env')
    err.status = 500
    throw err
  }
  return supabase
}

/** Ruta del objeto dentro del bucket a partir de la URL pública. */
function storagePathFromPublicUrl(publicUrl, bucket) {
  if (!publicUrl || typeof publicUrl !== 'string') return null
  const marker = `/object/public/${bucket}/`
  const idx = publicUrl.indexOf(marker)
  if (idx === -1) return null
  return decodeURIComponent(publicUrl.slice(idx + marker.length))
}

async function removePublicObject(publicUrl, bucket) {
  if (!publicUrl) return true
  if (!supabase) return false
  try {
    const path = storagePathFromPublicUrl(publicUrl, bucket)
    if (!path) return true // Not an object owned by this bucket; nothing to delete.
    const {error}=await supabase.storage.from(bucket).remove([path])
    return !error
  } catch {
    return false // Advisory cleanup must report failure without undoing a committed reference.
  }
}

/** Descarga el objeto del bucket como Buffer (evita fetch HTTP y problemas de CORS). */
async function downloadPublicObject(publicUrl, bucket) {
  if (!publicUrl || !supabase) return null
  const path = storagePathFromPublicUrl(publicUrl, bucket)
  if (!path) return null
  try {
    const { data, error } = await supabase.storage.from(bucket).download(path)
    if (error || !data) return null
    const buffer = Buffer.from(await data.arrayBuffer())
    return buffer.length ? buffer : null
  } catch {
    return null
  }
}

/**
 * Sube un buffer de imagen al bucket indicado.
 * @returns URL pública
 */
async function uploadImageBuffer({ bucket, file, pathPrefix = '' }) {
  const client = assertSupabase()

  if (!file?.buffer?.length) {
    const err = new Error('El archivo está vacío o no se pudo leer correctamente')
    err.status = 400
    throw err
  }
  if (!file.mimetype?.startsWith('image/')) {
    const err = new Error('Solo se permiten archivos de imagen')
    err.status = 400
    throw err
  }
  if (file.size > 5 * 1024 * 1024) {
    const err = new Error('La imagen no debe exceder 5MB')
    err.status = 400
    throw err
  }

  const ext = (file.originalname?.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const filePath = pathPrefix ? `${pathPrefix.replace(/\/$/, '')}/${fileName}` : fileName

  const { data: uploadData, error: uploadError } = await client.storage
    .from(bucket)
    .upload(filePath, file.buffer, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.mimetype,
    })

  if (uploadError) {
    const err = new Error('Error al subir la imagen: ' + uploadError.message)
    err.status = 500
    throw err
  }
  if (!uploadData) {
    const err = new Error('Error al subir la imagen: No se recibió confirmación')
    err.status = 500
    throw err
  }

  const { data: urlData } = client.storage.from(bucket).getPublicUrl(filePath)
  if (!urlData?.publicUrl) {
    const err = new Error('Error al obtener la URL pública de la imagen')
    err.status = 500
    throw err
  }
  return urlData.publicUrl
}

module.exports = {
  supabase,
  assertSupabase,
  storagePathFromPublicUrl,
  removePublicObject,
  downloadPublicObject,
  uploadImageBuffer,
  CATEGORY_IMAGES_BUCKET: 'categorias',
  COMPANY_LOGO_BUCKET: 'logo',
}
