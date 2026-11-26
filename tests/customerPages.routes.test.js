const test = require("node:test"),
  assert = require("node:assert/strict"),
  express = require("express"),
  { randomUUID } = require("node:crypto"),
  { fixture, scope } = require("./helpers/customerPagesDb");
async function server(t, permissionScope = scope) {
  const f = fixture(),
    app = express();
  app.use(
    "/api/settings/customer-pages",
    require("../src/modules/config/customerPages/bodyBoundary").createBodyBoundary(),
  );
  app.use(express.json({ limit: "10mb" }));
  app.use(
    "/api/settings/customer-pages",
    require("../src/modules/config/customerPages/routes").createRouter({
      db: f.db,
      scope: () => permissionScope,
      auth: (_r, _s, n) => n(),
      allowedOrigins: ["http://portal.test"],
    }),
  );
  const s = app.listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  t.after(() => new Promise((r) => s.close(r)));
  return {
    ...f,
    url: `http://127.0.0.1:${s.address().port}/api/settings/customer-pages`,
  };
}
test("portal writes reject foreign/missing cookie origins and bound bodies before the global parser", async (t) => {
  const { url, templates } = await server(t),
    input = { name: "Página", documentType: "QUOTE", requestId: randomUUID() },
    headers = { "Content-Type": "application/json", Cookie: "session=x" };
  for (const origin of [undefined, "https://foreign.test", "null"]) {
    const r = await fetch(url, {
      method: "POST",
      headers: { ...headers, ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(input),
    });
    assert.equal(r.status, 403);
  }
  const large = await fetch(url, {
    method: "POST",
    headers: { ...headers, Origin: "http://portal.test" },
    body: JSON.stringify({ text: "a".repeat(641 * 1024) }),
  });
  assert.equal(large.status, 413);
  const r = await fetch(url, {
    method: "POST",
    headers: { ...headers, Origin: "http://portal.test" },
    body: JSON.stringify(input),
  });
  assert.equal(r.status, 201);
  assert.match(r.headers.get("cache-control"), /no-store/);
  assert.equal(templates.length, 1);
});
test("read permissions are enforced and the server never accepts body tenant authority", async (t) => {
  const denied = await server(t, { ...scope, permissions: [] });
  assert.equal((await fetch(denied.url)).status, 403);
  const { url, templates } = await server(t),
    r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://portal.test",
      },
      body: JSON.stringify({
        name: "Página",
        companyId: "other",
        documentType: "QUOTE",
        requestId: randomUUID(),
      }),
    });
  assert.equal(r.status, 422);
  assert.equal(templates.length, 0);
});

test("whole-page compilation is scoped, permission checked and never writes a draft", async t => {
  const { url, db, templates, versions, audits } = await server(t);
  const { createDraft } = require('../src/modules/config/customerPages/service');
  const draft = await createDraft(db, scope, { name: 'Diseño', documentType: 'QUOTE', requestId: randomUUID() });
  const before = structuredClone({ templates, versions, audits });
  const html = '<auna-page><auna-identity></auna-identity><auna-items></auna-items><auna-summary></auna-summary><auna-validity></auna-validity><auna-quote-response></auna-quote-response></auna-page>';
  const request = (base, id, design = draft.design) => fetch(`${base}/${id}/source-compile`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://portal.test' }, body: JSON.stringify({ design, html, css: '' }) });
  const result = await request(url, draft.id);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).design.nodes[1].type, 'Items');
  assert.deepEqual({ templates, versions, audits }, before);
  assert.equal((await request(url, randomUUID())).status, 404);
  templates[0].company_id = 'another-company';
  assert.equal((await request(url, draft.id)).status, 404);
  templates[0].company_id = scope.companyId;
  const denied = await server(t, { ...scope, permissions: ['customer_pages.view'] });
  assert.equal((await request(denied.url, draft.id)).status, 403);
  assert.equal((await request(url, draft.id, { ...draft.design, documentType: 'ORDER' })).status, 422);
});
