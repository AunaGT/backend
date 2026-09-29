class ImportCancelledError extends Error {
  constructor() {
    super('Importación cancelada')
    this.name = 'ImportCancelledError'
  }
}

function openImportStream(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  let closed = false
  let terminalSent = false
  res.once('close', () => { closed = true })

  return {
    emit(type, data = {}) {
      if (closed || res.destroyed || terminalSent) return false
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`)
      res.flush?.()
      if (type === 'complete' || type === 'error') terminalSent = true
      return true
    },
    cancelled: () => closed || Boolean(res.destroyed),
    end() {
      if (closed) return
      res.end()
    },
  }
}

async function runImportStream(res, { total, validate, save }) {
  const stream = openImportStream(res)
  let processed = 0
  try {
    stream.emit('phase', { phase: 'validating', processed: 0, total })
    const validation = await validate()
    if (stream.cancelled()) throw new ImportCancelledError()
    if (validation.invalidRows?.length) {
      stream.emit('error', {
        phase: 'error', processed: 0, total,
        message: `${validation.invalidRows.length} filas tienen errores.`,
        invalidRows: validation.invalidRows.map(({ rowIndex, errors }) => ({ rowIndex, errors })),
      })
      return
    }
    const rows = validation.validRows || []
    stream.emit('phase', { phase: 'saving', processed: 0, total: rows.length })
    const result = await save(rows, (progress) => {
      processed = progress.processed
      stream.emit('progress', { phase: 'saving', ...progress })
    }, stream.cancelled)
    if (stream.cancelled()) throw new ImportCancelledError()
    stream.emit('complete', { phase: 'complete', processed: rows.length, total: rows.length, result })
  } catch (error) {
    if (!(error instanceof ImportCancelledError) && !stream.cancelled()) {
      stream.emit('error', { phase: 'error', processed, total, message: processed ? `No se pudo completar la importación después de ${processed} filas procesadas. Verifica los datos antes de reintentar.` : 'No se pudo completar la importación.' })
    }
  } finally {
    stream.end()
  }
}

module.exports = { openImportStream, runImportStream, ImportCancelledError }
