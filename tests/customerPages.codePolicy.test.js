const test = require("node:test"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto"),
  { fixture, scope } = require("./helpers/customerPagesDb"),
  service = require("../src/modules/config/customerPages/service");
test("syntax validation does not mutate a saved draft or execute code; code policy is permissioned and revisioned", async () => {
  const server = require("../src/modules/config/customerPages/isolation/server"),
    f = fixture(),
    r = await service.createDraft(f.db, scope, {
      name: "Web",
      documentType: "QUOTE",
      requestId: randomUUID(),
    }),
    before = structuredClone(f.versions),
    coder = {
      ...scope,
      permissions: ["customer_pages.manage", "customer_pages.code"],
    };
  await server.validateCode(f.db, coder, r.id, {
    blockId: "demo",
    block: {
      html: "<p>Hola</p>",
      css: "",
      js: "globalThis.notExecuted=1",
      fallbackText: "Hola",
    },
    resources: {},
  });
  assert.equal(globalThis.notExecuted, undefined);
  assert.deepEqual(f.versions, before);
  await assert.rejects(
    () =>
      server.setCodePolicy(f.db, scope, { enabled: true, expectedRevision: 0 }),
    (e) => e.status === 403,
  );
  assert.equal(
    (
      await server.setCodePolicy(f.db, coder, {
        enabled: true,
        expectedRevision: 0,
      })
    ).revision,
    1,
  );
  await assert.rejects(
    () =>
      server.setCodePolicy(f.db, coder, {
        enabled: false,
        expectedRevision: 0,
      }),
    (e) => e.status === 409,
  );
  assert.equal(
    (
      await server.setCodePolicy(f.db, coder, {
        enabled: false,
        expectedRevision: 1,
      })
    ).enabled,
    false,
  );
});
