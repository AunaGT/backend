const test = require('node:test'), assert = require('node:assert/strict')
const { resolveBase } = require('../src/modules/config/customerPages/bases')
const compiler = () => require('../src/modules/config/customerPages/pageSource')
const source = () => ({ baseDesign: resolveBase('QUOTE'), html: '<auna-page><auna-identity id="identity"></auna-identity><section id="content"><h2>Título nuevo</h2><auna-items id="items"></auna-items></section><auna-validity id="validity"></auna-validity><auna-summary id="summary"></auna-summary><auna-quote-response id="response"></auna-quote-response></auna-page>', css: '#content { padding: 32px; }\n@media (max-width: 639px) { #content { padding: 16px; } }' })
test('safe page width and gutters compile without opening arbitrary CSS or node styles', async () => {
  const result = await compiler().compilePageSource({ ...source(), css: 'auna-page { -auna-content-width: full; padding: 0px; }' })
  assert.deepEqual(result.theme, { contentWidth: 'full', padding: 0 })
  const centered = await compiler().compilePageSource({ ...source(), css: 'auna-page { -auna-content-width: contained; padding: 32px; }' })
  assert.equal(centered.theme.contentWidth, 'contained')
  for (const css of ['auna-page { -auna-content-width: arbitrary; }', 'auna-page { padding: -1px; }', 'auna-page { padding: 97px; }', 'auna-page { width: 100vw; }', '#content { -auna-content-width: full; }']) {
    await assert.rejects(() => compiler().compilePageSource({ ...source(), css }), { status: 422 })
  }
})
test('page source compiles editable layout/content and responsive styles without modifying input', async () => {
  const input = source(), before = structuredClone(input)
  const result = await compiler().compilePageSource(input)
  assert.equal(result.nodes[1].children[0].props.text, 'Título nuevo')
  assert.deepEqual(result.nodes[1].styles, { desktop: { padding: 32 }, tablet: {}, mobile: { padding: 16 } })
  assert.deepEqual(input, before)
})
test('page source rejects executable markup and unrepresentable CSS with positions', async () => {
  for (const change of [
    { html: '<script>alert(1)</script>' }, { html: '<section onclick="alert(1)"></section>' },
    { html: '<iframe></iframe>' }, { html: '<p><b>silently dropped?</b></p>' },
    { css: '@import "https://evil.test";' }, { css: '#content { display: none; }' },
    { css: '#content { background: url(https://evil.test); }' },
    { css: 'body { color: #ffffff; }' }, { css: '#content { transform: scale(0); }' },
  ]) {
    await assert.rejects(() => compiler().compilePageSource({ ...source(), ...change }), error => {
      assert.equal(error.status, 422)
      assert.ok(error.diagnostics[0].line >= 1)
      assert.ok(error.diagnostics[0].column >= 1)
      return true
    })
  }
})
test('required slots, unique ids, resource references and source bounds cannot be bypassed', async () => {
  const original = source()
  for (const html of [original.html.replace('<auna-summary id="summary"></auna-summary>', ''), original.html.replace('id="summary"', 'id="items"'), original.html.replace('</section>', '<img data-asset="foreign"></section>')])
    await assert.rejects(() => compiler().compilePageSource({ ...original, html }), { status: 422 })
  await assert.rejects(() => compiler().compilePageSource({ ...original, html: 'a'.repeat(512 * 1024 + 1) }), { status: 413 })
})
test('semantic image alt updates the resource instead of silently losing the input', async () => {
  const input = source()
  input.baseDesign.resources.photo = { assetId: '', alt: 'Anterior' }
  input.html = input.html.replace('</section>', '<img data-asset="photo" alt="Logo nuevo"></section>')
  const result = await compiler().compilePageSource(input)
  assert.equal(result.resources.photo.alt, 'Logo nuevo')
})
