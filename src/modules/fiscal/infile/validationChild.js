const { spawn } = require('node:child_process')
const { fail } = require('../errors')
const MAX_BYTES = 2 * 1024 * 1024
const MEMORY_BYTES = 128 * 1024 * 1024
function xmlError(code = 'FISCAL_XML_INVALID') { return fail(422, code, 'El XML local no cumple los límites o la estructura permitidos') }
function preflightXml(xml) {
  if (!Buffer.isBuffer(xml) || !xml.length || xml.length > MAX_BYTES) throw xmlError('FISCAL_XML_SIZE_LIMIT')
  let source
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(xml) } catch { throw xmlError('FISCAL_XML_ENCODING_INVALID') }
  if (/<!|http:\/\/www\.w3\.org\/2001\/XInclude/.test(source)) throw xmlError('FISCAL_XML_EXTERNAL_FORBIDDEN')
  if (source.startsWith('<?xml ')) {
    const end = source.indexOf('?>')
    if (end < 0 || !/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-8"|'UTF-8'))?\s*\?>$/i.test(source.slice(0, end + 2))) throw xmlError('FISCAL_XML_ENCODING_INVALID')
    source = source.slice(end + 2)
  }
  if (source.includes('<?')) throw xmlError('FISCAL_XML_EXTERNAL_FORBIDDEN')
  let depth = 0, nodes = 0, i = 0
  // Quote-aware linear scan: enforce budgets before invoking native parsing.
  while (i < source.length) {
    if (source[i] !== '<') {
      const end = source.indexOf('<', i), next = end < 0 ? source.length : end
      if (next > i) nodes++
      i = next
    } else {
      const start = i++, closing = source[i] === '/'
      let quote = null, closed = false
      for (; i < source.length; i++) {
        const c = source[i]
        if (c === '<') throw xmlError()
        if (quote) { if (c === quote) quote = null }
        else if (c === '"' || c === "'") quote = c
        else if (c === '=') nodes++
        else if (c === '>') { closed = true; break }
      }
      if (!closed) throw xmlError()
      const token = source.slice(start, i + 1)
      if (/(?:^|\s)(?:[\w.-]+:)?(?:schemaLocation|noNamespaceSchemaLocation)\s*=/.test(token)) throw xmlError('FISCAL_XML_EXTERNAL_FORBIDDEN')
      if (closing) depth--
      else { nodes++; if (++depth > 64) throw xmlError('FISCAL_XML_DEPTH_LIMIT'); if (source[i - 1] === '/') depth-- }
      if (depth < 0) throw xmlError()
      i++
    }
    if (nodes > 50000) throw xmlError('FISCAL_XML_NODE_LIMIT')
  }
  if (depth !== 0) throw xmlError()
}

function supervise(command, args, { input = Buffer.alloc(0), timeoutMs = 5000, maxOutput = MAX_BYTES, signal, allowDiagnostics = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(xmlError('FISCAL_XML_ABORTED'))
    const child = spawn(command, args, { env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'], detached: true, shell: false })
    let done = false, size = 0, diagnostics = false, chunks = [], timer
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    const finish = (error, output) => {
      if (done) return
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (error) { stop(); chunks = []; reject(error) } else resolve(output)
    }
    const abort = () => finish(xmlError('FISCAL_XML_ABORTED'))
    timer = setTimeout(() => finish(fail(504, 'FISCAL_XML_TIMEOUT', 'La revisión XML superó el tiempo permitido')), Math.max(1, timeoutMs))
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', () => finish(fail(503, 'FISCAL_XML_RUNTIME_UNAVAILABLE', 'El validador XML aislado no está disponible')))
    const count = chunk => { size += chunk.length; if (size > maxOutput) finish(xmlError('FISCAL_XML_OUTPUT_LIMIT')) }
    child.stdout.on('data', chunk => { count(chunk); if (!done) chunks.push(chunk) })
    // Parser diagnostics may quote personal data or XML: count, never retain/log.
    child.stderr.on('data', chunk => { diagnostics = true; count(chunk) })
    child.stdin.on('error', () => {})
    child.on('close', code => finish(code === 0 && (!diagnostics || allowDiagnostics) ? null : xmlError(), Buffer.concat(chunks)))
    child.stdin.end(input)
  })
}

function isolationArgs(mode) {
  return ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
    '--ro-bind', '/usr/bin/xmllint', '/usr/bin/xmllint', '--ro-bind', '/usr/bin/prlimit', '/usr/bin/prlimit',
    '--ro-bind', '/usr/lib', '/usr/lib', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--dir', '/tmp', '--chdir', '/tmp',
    '--setenv', 'LC_ALL', 'C', '--setenv', 'XML_CATALOG_FILES', '',
    '--', '/usr/bin/prlimit', `--as=${MEMORY_BYTES}`, '--cpu=5', '--', '/usr/bin/xmllint',
    ...(mode === 'probe' ? ['--version'] : ['--nonet', '--nocatalogs', '--c14n', '-'])]
}
async function runIsolatedXml(xml, { deadline = Date.now() + 5000, signal, mode = 'canonical' } = {}) {
  if (process.platform !== 'linux' || !['canonical', 'probe'].includes(mode)) throw fail(503, 'FISCAL_XML_RUNTIME_UNAVAILABLE', 'El validador XML aislado no está disponible')
  if (mode === 'canonical') preflightXml(xml)
  const timeoutMs = Math.min(5000, deadline - Date.now())
  if (timeoutMs <= 0) throw fail(504, 'FISCAL_XML_TIMEOUT', 'La revisión XML superó el tiempo permitido')
  return supervise('/usr/bin/bwrap', isolationArgs(mode), { input: mode === 'probe' ? Buffer.alloc(0) : xml, timeoutMs, signal, allowDiagnostics: mode === 'probe' })
}
async function checkXmlRuntime() {
  try { await runIsolatedXml(null, { mode: 'probe' }) } catch { throw fail(503, 'FISCAL_XML_RUNTIME_UNAVAILABLE', 'Falta preparar el validador XML aislado; no se omitirá la validación') }
  return Object.freeze({ available: true, isolation: 'BWRAP_NAMESPACES_PRLIMIT', memoryLimitBytes: MEMORY_BYTES, timeoutMs: 5000, officialSchemasAvailable: false, externalSendingAllowed: false })
}
module.exports = { preflightXml, supervise, isolationArgs, runIsolatedXml, checkXmlRuntime }
