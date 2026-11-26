const test = require("node:test"),
  assert = require("node:assert/strict");
test("custom code is syntax-checked and assembled without evaluating it or escaping its container", () => {
  const {
    compileCustomBlock,
  } = require("../src/modules/config/customerPages/isolation/compile");
  const result = compileCustomBlock(
    {
      html: "<h2>Bienvenido</h2>",
      css: "h2 { color: #112233 }",
      js: 'globalThis.mustNotRun=42; const text="</script>";',
      fallbackText: "Hola",
    },
    { channelId: "channel-123" },
  );
  assert.equal(globalThis.mustNotRun, undefined);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.csp, /sandbox allow-scripts/);
  assert.match(result.csp, /connect-src 'none'/);
  assert.match(result.csp, /sha256-/);
  assert.equal((result.html.match(/<\/script>/g) || []).length, 2);
});
test("external loads, active HTML, unsafe CSS and malformed JavaScript produce actionable diagnostics", () => {
  const {
    compileCustomBlock,
  } = require("../src/modules/config/customerPages/isolation/compile");
  const valid = { html: "<p>Hola</p>", css: "", js: "", fallbackText: "Hola" };
  for (const change of [
    { html: '<script src="https://evil.test/x.js"></script>' },
    { html: '<base href="https://evil.test">' },
    { html: '<form action="https://evil.test"><input></form>' },
    { html: '<img src="https://evil.test/a">' },
    { html: '<p onclick="alert(1)">x</p>' },
    { css: '@import "https://evil.test/a.css";' },
    { css: "p{background:url(https://evil.test/a)}" },
    { js: 'import x from "https://evil.test/x.js"' },
    { js: 'import("https://evil.test/x.js")' },
    { js: "const x = ;" },
  ])
    assert.throws(
      () =>
        compileCustomBlock(
          { ...valid, ...change },
          { channelId: "channel-123" },
        ),
      (e) => e.status === 422 && e.diagnostics?.[0].line >= 1,
    );
});
