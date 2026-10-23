/**
 * Logo de empresa para PDFs (PDFKit): descarga desde Storage/URL y rasteriza para PDF.
 */

const sharp = require('sharp')
const { getSystemConfig } = require('./getTimezone')
const { downloadPublicObject, COMPANY_LOGO_BUCKET } = require('../services/supabaseStorage')

/** @type {Map<string, { buffer: Buffer, contentType: string, expiresAt: number }>} */
const logoBufferCache = new Map()
const LOGO_CACHE_TTL_MS = 5 * 60 * 1000

function isSvgBuffer(buffer) {
  if (!buffer?.length) return false
  const head = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8').trimStart()
  return head.startsWith('<svg') || head.startsWith('<?xml')
}

/**
 * Convierte cualquier imagen (SVG, WebP, etc.) a PNG/JPEG usable por PDFKit.
 * @returns {{ buffer: Buffer, contentType: string } | null}
 */
async function rasterizeLogoBuffer(buffer) {
  if (!buffer?.length) return null
  try {
    if (isSvgBuffer(buffer)) {
      const png = await sharp(buffer, { density: 150 }).png().toBuffer()
      return { buffer: png, contentType: 'image/png' }
    }
    const meta = await sharp(buffer).metadata()
    if (meta.format === 'jpeg' || meta.format === 'jpg') {
      return { buffer, contentType: 'image/jpeg' }
    }
    if (meta.format === 'png') {
      return { buffer, contentType: 'image/png' }
    }
    const png = await sharp(buffer).png().toBuffer()
    return { buffer: png, contentType: 'image/png' }
  } catch {
    return null
  }
}

async function downloadRawLogoBuffer(logoUrl) {
  const url = logoUrl != null ? String(logoUrl).trim() : ''
  if (!url) return null

  const fromStorage = await downloadPublicObject(url, COMPANY_LOGO_BUCKET)
  if (fromStorage) return fromStorage

  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    return buffer.length ? buffer : null
  } catch {
    return null
  }
}

async function fetchLogoBuffer(logoUrl) {
  const url = logoUrl != null ? String(logoUrl).trim() : ''
  if (!url) return null

  const cached = logoBufferCache.get(url)
  if (cached && cached.expiresAt > Date.now()) return cached.buffer

  const raw = await downloadRawLogoBuffer(url)
  const raster = await rasterizeLogoBuffer(raw)
  if (!raster) return null

  logoBufferCache.set(url, {
    buffer: raster.buffer,
    contentType: raster.contentType,
    expiresAt: Date.now() + LOGO_CACHE_TTL_MS,
  })
  return raster.buffer
}

/**
 * Buffer + content-type para servir logo vía HTTP (frontend PDFs).
 * @returns {Promise<{ buffer: Buffer, contentType: string } | null>}
 */
async function fetchBoundedLogo(url, {signal,maxBytes}) {
  if(signal?.aborted)return null
  let reader,image
  const cancelImage=()=>image?.destroy()
  try {
    const response=await fetch(url,{signal})
    if(!response.ok||Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel();return null}
    if(!response.body)return null
    reader=response.body.getReader()
    const chunks=[];let size=0
    while(true){
      const {done,value}=await reader.read()
      if(done)break
      size+=value.byteLength
      if(signal?.aborted||size>maxBytes){await reader.cancel();return null}
      chunks.push(value)
    }
    if(!size||signal?.aborted)return null
    const raw=Buffer.concat(chunks,size)
    image=sharp(raw,{limitInputPixels:16777216,...(isSvgBuffer(raw)?{density:150}:{})})
    signal?.addEventListener('abort',cancelImage,{once:true})
    const meta=await image.metadata()
    if(signal?.aborted)return null
    const raster=meta.format==='jpeg'||meta.format==='png'
      ?{buffer:raw,contentType:meta.format==='jpeg'?'image/jpeg':'image/png'}
      :{buffer:await image.resize({width:512,height:512,fit:'inside',withoutEnlargement:true}).png().toBuffer(),contentType:'image/png'}
    if(signal?.aborted||!raster.buffer.length||raster.buffer.length>maxBytes)return null
    logoBufferCache.set(url,{...raster,expiresAt:Date.now()+LOGO_CACHE_TTL_MS})
    return raster
  } catch {return null}
  finally {signal?.removeEventListener('abort',cancelImage);reader?.releaseLock();image?.destroy()}
}

async function fetchLogoForHttp(logoUrl, options) {
  const url = logoUrl != null ? String(logoUrl).trim() : ''
  if (!url||options?.signal?.aborted) return null

  const cached = logoBufferCache.get(url)
  if (cached && cached.expiresAt > Date.now()) {
    if(options&&cached.buffer.length>options.maxBytes)return null
    return { buffer: cached.buffer, contentType: cached.contentType }
  }

  if(options)return fetchBoundedLogo(url,options)

  const raw = await downloadRawLogoBuffer(url)
  const raster = await rasterizeLogoBuffer(raw)
  if (!raster) return null

  logoBufferCache.set(url, {
    buffer: raster.buffer,
    contentType: raster.contentType,
    expiresAt: Date.now() + LOGO_CACHE_TTL_MS,
  })
  return raster
}

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} companyId empresa cuyo membrete se imprime
 */
async function getBrandingForPdf(prisma, companyId) {
  const config = await getSystemConfig(prisma, companyId)
  const logoUrl = config.company_logo_url || ''
  const logoBuffer = await fetchLogoBuffer(logoUrl)
  return {
    ...config,
    logoBuffer,
  }
}

const PDF_COLORS = { navy: '#0c203a', orange: '#ff6f00', muted: '#63758b', border: '#d8e1eb', zebra: '#f7f9fc' }

function setupReportPdf(doc, { branding, title, metadata = [] }) {
  doc._reportPdf = { branding, title, metadata }
  const drawHeader = (continued = false) => {
    const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right
    let y = doc.page.margins.top
    if (branding.logoBuffer) {
      try {
        const image = doc.openImage(branding.logoBuffer)
        const scale = Math.min((continued ? 52 : 90) / image.width, (continued ? 22 : 45) / image.height)
        const w = image.width * scale, h = image.height * scale
        doc.image(branding.logoBuffer, (doc.page.width - w) / 2, y, { width: w, height: h })
        y += h + 9
      } catch { /* El nombre de empresa sigue identificando un logo inválido. */ }
    }
    doc.font('Helvetica-Bold').fontSize(continued ? 10 : 18).fillColor(PDF_COLORS.navy)
      .text(branding.company_name || 'Depósito', left, y, { width, align: 'center' })
    y = doc.y + 8
    doc.moveTo(left, y).lineTo(left + width, y).lineWidth(continued ? 1 : 2).strokeColor(PDF_COLORS.orange).stroke()
    doc.font('Helvetica-Bold').fontSize(continued ? 11 : 20).fillColor(PDF_COLORS.navy)
      .text(title, left, y + 10, { width })
    doc.font('Helvetica').fontSize(8).fillColor(PDF_COLORS.muted)
    for (const line of metadata) doc.text(String(line), left, doc.y + 3, { width })
    doc.x = left
    doc.y += 12
  }
  doc.on('pageAdded', () => drawHeader(true))
  drawHeader()
}

function ensureReportSpace(doc, height) {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom - 20) doc.addPage()
}

// PDFKit wraps ordinary paragraphs; table fragments need measured lines to split one tall cell across pages.
function reportLines(doc, value, width) {
  const lines = []
  for (const paragraph of String(value ?? '').split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && doc.widthOfString(`${line} ${word}`) > width) { lines.push(line); line = '' }
      if (doc.widthOfString(word) > width) {
        for (const char of word) {
          if (line && doc.widthOfString(line + char) > width) { lines.push(line); line = '' }
          line += char
        }
      } else line += `${line ? ' ' : ''}${word}`
    }
    lines.push(line)
  }
  return lines
}

function drawReportTable(doc, columns, rows, options = {}) {
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right
  const weights = options.widths?.length === columns.length ? options.widths : columns.map(() => 1)
  const total = weights.reduce((sum, value) => sum + value, 0)
  const widths = weights.map(value => width * value / total), padding = 6, lineHeight = 10
  doc.font('Helvetica-Bold').fontSize(8)
  const headers = columns.map((column, i) => reportLines(doc, typeof column === 'string' ? column : column.text, Math.max(4, widths[i] - padding * 2)))
  const headerHeight = Math.max(...headers.map(lines => lines.length)) * lineHeight + 10
  const drawCells = (cells, top, bold, aligns = []) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(bold ? '#ffffff' : PDF_COLORS.navy)
    let x = left
    cells.forEach((lines, i) => {
      lines.forEach((line, n) => doc.text(line, x + padding, top + 5 + n * lineHeight, { width: Math.max(4, widths[i] - padding * 2), align: aligns[i] || columns[i]?.align || 'left', lineBreak: false }))
      x += widths[i]
    })
  }
  const drawHeader = () => {
    const top = doc.y
    doc.rect(left, top, width, headerHeight).fill(PDF_COLORS.navy)
    drawCells(headers, top, true, options.headerAlign || options.align)
    doc.y = top + headerHeight
  }
  ensureReportSpace(doc, headerHeight + 20)
  drawHeader()
  const body = rows.length ? rows : [columns.map((_, i) => i ? '' : 'Sin registros para este alcance.')]
  body.forEach((row, rowIndex) => {
    doc.font('Helvetica').fontSize(8)
    const cells = columns.map((_, i) => reportLines(doc, row[i], Math.max(4, widths[i] - padding * 2)))
    const count = Math.max(...cells.map(lines => lines.length))
    const bottom = doc.page.height - doc.page.margins.bottom - 20
    if (doc.y + count * lineHeight + 10 > bottom && count * lineHeight + 10 < bottom - doc.page.margins.top - 120 - headerHeight) { doc.addPage(); drawHeader() }
    let offset = 0
    while (offset < count) {
      let available = Math.floor((bottom - doc.y - 10) / lineHeight)
      if (available < 1) { doc.addPage(); drawHeader(); available = Math.floor((bottom - doc.y - 10) / lineHeight) }
      const lines = Math.min(count - offset, Math.max(1, available)), top = doc.y, height = lines * lineHeight + 10
      doc.rect(left, top, width, height).fill(rowIndex % 2 ? '#ffffff' : PDF_COLORS.zebra)
      drawCells(cells.map(cell => cell.slice(offset, offset + lines)), top, false, options.align)
      doc.moveTo(left, top + height).lineTo(left + width, top + height).lineWidth(.4).strokeColor(PDF_COLORS.border).stroke()
      doc.y = top + height
      offset += lines
      if (offset < count) { doc.addPage(); drawHeader() }
    }
  })
  doc.x = left
  doc.y += 10
}

function finishReportPdf(doc) {
  const { branding } = doc._reportPdf || { branding: {} }
  const pages = doc.bufferedPageRange()
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    doc.switchToPage(i)
    const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right, y = doc.page.height - 32
    const bottomMargin = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    doc.moveTo(left, y - 9).lineTo(left + width, y - 9).lineWidth(.4).strokeColor(PDF_COLORS.border).stroke()
    doc.font('Helvetica').fontSize(8).fillColor(PDF_COLORS.muted)
    doc.text([branding.currency_code, branding.timezone].filter(Boolean).join(' · '), left, y, { width, lineBreak: false })
    doc.text(`Página ${i + 1} de ${pages.count}`, left, y, { width, align: 'right', lineBreak: false })
    doc.page.margins.bottom = bottomMargin
  }
}

module.exports = {
  fetchLogoBuffer,
  fetchLogoForHttp,
  rasterizeLogoBuffer,
  getBrandingForPdf,
  PDF_COLORS,
  setupReportPdf,
  ensureReportSpace,
  drawReportTable,
  finishReportPdf,
  reportLines,
}
