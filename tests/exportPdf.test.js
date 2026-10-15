const test = require('node:test')
const assert = require('node:assert/strict')
const { PassThrough } = require('node:stream')
const PDFDocument = require('pdfkit')
const sharp = require('sharp')
const branding = require('../src/utils/pdfBranding')

function collect(doc) {
  const chunks = []
  doc.on('data', chunk => chunks.push(chunk))
  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
}

test('tablas PDF conservan celdas largas, repiten membrete/cabecera y numeran todas las páginas', async () => {
  assert.equal(typeof branding.setupReportPdf, 'function')
  const doc = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true, compress: false })
  const output = collect(doc)
  const texts = [], images = []
  const originalText = doc.text, originalImage = doc.image
  doc.text = function (value, x, y, options) {
    texts.push({ value: String(value), x, y, options, page: this._pageBuffer.length })
    return originalText.call(this, value, x, y, options)
  }
  doc.image = function (value, x, y, options) { images.push({ x, y, options }); return originalImage.call(this, value, x, y, options) }
  const logoBuffer = await sharp({ create: { width: 240, height: 60, channels: 4, background: '#ff6f00' } }).png().toBuffer()
  branding.setupReportPdf(doc, { branding: { company_name: 'Empresa de prueba', logoBuffer, currency_code: 'GTQ', timezone: 'America/Guatemala' }, title: 'Informe de Productos', metadata: ['Alcance: Central'] })
  const veryLong = 'Descripción completa '.repeat(650) + 'MARCADOR-FINAL'
  branding.drawReportTable(doc, ['Nombre', 'Descripción', 'Cantidad'], [['Producto inicial', veryLong, '0.125'], ...Array.from({ length: 90 }, (_, i) => [`Producto ${i}`, 'Contenido de prueba', String(i)])], { widths: [120, 290, 97.28], align: ['left', 'left', 'right'] })
  branding.finishReportPdf(doc)
  doc.end()
  const buffer = await output
  const pages = (buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length
  assert.ok(pages >= 3)
  assert.equal(texts.filter(t => t.value === 'Empresa de prueba').length, pages)
  assert.equal(texts.filter(t => t.value === 'Nombre').length, pages)
  assert.ok(texts.some(t => t.value.includes('MARCADOR-FINAL')))
  assert.equal(texts.filter(t => /^Página \d+ de \d+$/.test(t.value)).length, pages)
  assert.ok(texts.every(t => !t.options?.ellipsis))
  assert.equal(images[0].options.width / images[0].options.height, 4)
  assert.equal(images[0].x + images[0].options.width / 2, doc.page.width / 2)
})

async function controllerPdf(moduleName, prisma, query, method = 'generateReport', params = {}) {
  const dbPath = require.resolve('../src/models/prisma')
  const controllerPath = require.resolve(`../src/modules/${moduleName === 'inventory' ? 'inventory/products.controller' : `${moduleName}/controller`}`)
  const previous = require.cache[dbPath]
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma } }
  try {
    delete require.cache[controllerPath]
    const response = new PassThrough(), headers = {}, chunks = []
    response.setHeader = (name, value) => { headers[name] = value }
    response.on('data', chunk => chunks.push(chunk))
    const done = new Promise((resolve, reject) => { response.on('finish', resolve); response.on('error', reject) })
    let error
    await require(controllerPath)[method]({ companyId: `pdf-${moduleName}`, branchId: 'central', branchIds: ['central'], query, params }, response, value => { error = value })
    if (error) throw error
    await done
    const buffer = Buffer.concat(chunks)
    if (process.env.PDF_FIXTURE_DIR) {
      const fs = require('node:fs'), path = require('node:path')
      fs.mkdirSync(process.env.PDF_FIXTURE_DIR, { recursive: true })
      fs.writeFileSync(path.join(process.env.PDF_FIXTURE_DIR, `${moduleName}-${method}${query.fields ? '-table' : ''}.pdf`), buffer)
    }
    return { buffer, headers }
  } finally {
    delete require.cache[controllerPath]
    if (previous) require.cache[dbPath] = previous
    else delete require.cache[dbPath]
  }
}

function pdfText(buffer) {
  const streams = [...buffer.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map(match => { try { return require('node:zlib').inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1') } catch { return match[1] } }).join('\n')
  return [...streams.matchAll(/<([a-f\d]+)>/gi)].map(match => Buffer.from(match[1], 'hex').toString('latin1')).join('')
}

test('inventariado PDF conserva todas las líneas y nombres completos en páginas numeradas', async () => {
  let sessionWhere, linesWhere
  const { buffer } = await controllerPdf('reports', {
    systemSetting: { findMany: async () => [{ key: 'company_name', value: 'Empresa Inventariado' }] },
    inventoryCountSession: { findFirst: async ({ where }) => {
      sessionWhere = where
      return { id: 'session', name: 'Conteo físico', status: 'APPROVED', created_at: new Date(), createdBy: { name: 'Usuario' } }
    } },
    inventoryCountLine: { findMany: async ({ where }) => {
      linesWhere = where
      return Array.from({ length: 105 }, (_, i) => ({ product: { name: i === 104 ? 'Producto con nombre extenso MARCADOR-ULTIMA-LINEA' : `Producto ${i}`, barcode: `${i}`, cost: 8 }, location: { code: 'UBICACION-COMPLETA', warehouse: { name: 'Bodega' } }, stock_snapshot: 2, qty_counted: 1.125, qty_counted_secondary: 1.125 }))
    } },
  }, {}, 'inventoryCountSessionReport', { id: 'session' })
  assert.equal(sessionWhere.id, 'session')
  assert.equal(sessionWhere.branch_id, 'central')
  assert.deepEqual(linesWhere, { session_id: 'session', product: { kind: { not: 'SERVICE' } } })
  const text = pdfText(buffer)
  assert.match(text, /MARCADOR-ULTIMA-LINEA/)
  assert.match(text, /UBICACION-COMPLETA/)
  assert.match(text, /Página 1 de/)
})

test('productos PDF respeta columnas seleccionadas, stock de sucursal y catálogo de servicios', async () => {
  let where
  const prisma = {
    systemSetting: { findMany: async () => [{ key: 'company_name', value: 'Empresa Productos' }], findUnique: async () => ({ value: 'true' }) },
    branch: { findUnique: async () => ({ name: 'Central' }) },
    productStock: { findMany: async () => [{ product_id: 'good', stock: 2.125, min_stock: 1 }] },
    product: { findMany: async args => {
      where = args.where
      return [{ id: 'good', kind: 'GOOD', name: 'Producto con nombre completo MARCADOR-NOMBRE', stock: 999, cost: 9, price: 10 }, { id: 'service', kind: 'SERVICE', name: 'Servicio', service_unit_label: 'hora', quantity_decimals: 3, stock: 999, price: 12, available_for_sale: true }]
    } },
  }
  const { buffer, headers } = await controllerPdf('inventory', prisma, { fields: 'name,price,stock,kind,service_unit_label', includeSummary: 'false', catalog_type: 'all', ids: 'good,service', search: 'test' }, 'reportPdf')
  assert.equal(where.company_id, 'pdf-inventory')
  assert.deepEqual(where.id, { in: ['good', 'service'] })
  assert.equal(where.OR[0].name.contains, 'test')
  assert.equal(headers['Content-Disposition'], 'inline; filename="productos_reporte.pdf"')
  const text = pdfText(buffer)
  assert.match(text, /MARCADOR-NOMBRE/)
  assert.match(text, /2\.125/)
  assert.match(text, /hora/)
  assert.doesNotMatch(text, /999/)
  assert.match(text, /Página 1 de/)
})

test('tarjetas de productos conservan descripción, mayoreo y promoción al paginar', async () => {
  const { buffer } = await controllerPdf('inventory', {
    systemSetting: { findMany: async () => [] },
    branch: { findUnique: async () => ({ name: 'Central' }) },
    productStock: { findMany: async () => [] },
    product: { findMany: async () => Array.from({ length: 10 }, (_, i) => ({ id: String(i), kind: 'GOOD', name: 'Producto con nombre de varias líneas '.repeat(3), category: { name: 'Categoría con nombre completo' }, description: 'Descripción de producto '.repeat(7) + 'FIN-DESCRIPCION', price: 10, cost: 8, price_wholesale: 9, price_promotion: 7, supplier: { name: 'Proveedor con nombre completo' }, status: { name: 'Activo' } })) },
  }, { includeSummary: 'false' }, 'reportPdf')
  const text = pdfText(buffer)
  assert.match(text, /FIN-DESCRIPCION/)
  assert.match(text, /Mayoreo/)
  assert.match(text, /Promo/)
  assert.match(text, /Página 1 de/)
})

test('tarjeta más alta que una página conserva texto sin dibujar fuera de los márgenes', async () => {
  const original = PDFDocument.prototype.roundedRect
  const cards = []
  PDFDocument.prototype.roundedRect = function (x, y, width, height, ...rest) {
    cards.push({ y, height, bottom: this.page.height - this.page.margins.bottom })
    return original.call(this, x, y, width, height, ...rest)
  }
  try {
    const { buffer } = await controllerPdf('inventory', {
      systemSetting: { findMany: async () => [] },
      branch: { findUnique: async () => ({ name: 'Central' }) },
      productStock: { findMany: async () => [] },
      product: { findMany: async () => [{ id: 'long', name: 'Producto extenso', price: 10, description: 'Descripción completa '.repeat(650) + 'FIN-TARJETA' }] },
    }, { includeSummary: 'false' }, 'reportPdf')
    assert.match(pdfText(buffer), /FIN-TARJETA/)
    assert.ok(cards.every(card => card.y + card.height <= card.bottom))
  } finally { PDFDocument.prototype.roundedRect = original }
})

test('mercancía genera un PDF paginado conservando filtro, cantidades fraccionadas y total', async () => {
  let where
  const { buffer, headers } = await controllerPdf('merchandise', {
    systemSetting: { findMany: async () => [{ key: 'company_name', value: 'Empresa Mercancía' }] },
    incomingMerchandise: { findMany: async args => {
      where = args.where
      return [{ date: new Date('2026-10-11T12:00:00Z'), supplier: { name: 'Proveedor de prueba' }, registeredBy: { name: 'Usuario' }, paymentTerm: { name: 'Contado' }, payment_status: 'PARTIAL', payment_reference: 'REFERENCIA-CONSERVADA', notes: 'Notas extensas '.repeat(80), items: Array.from({ length: 90 }, (_, i) => ({ product: { name: `Producto ${i}`, brand: 'Marca', size: 'Grande' }, quantity: 0.125, unit_cost: 8 })) }]
    } },
  }, { search: 'prueba', payment_status: 'PARTIAL' })
  assert.equal(where.branch_id, 'central')
  assert.equal(where.payment_status, 'PARTIAL')
  assert.equal(where.OR[0].supplier.name.contains, 'prueba')
  assert.equal(headers['Content-Disposition'], 'attachment; filename="reporte-mercancia.pdf"')
  assert.ok((buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length > 1)
  const text = pdfText(buffer)
  assert.match(text, /Página 1 de/)
  assert.match(text, /0\.125/)
  assert.match(text, /90\.00/)
  assert.match(text, /REFERENCIA-CONSERVADA/)
})
