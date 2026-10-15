const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { makePayablesFixture } = require("./helpers/payablesFixture.cjs"),
  { assertAccess } = require("../src/modules/merchandise/payables/access");
test("customer collection permission does not allow supplier financial access or payment", async () => {
  const f = makePayablesFixture(),
    scope = {
      ...f.scope,
      permissions: ["receivables.view", "receivables.manage"],
    };
  await assert.rejects(
    () => assertAccess(f.db, scope),
    (e) => e.status === 403,
  );
  await assert.rejects(
    () => assertAccess(f.db, scope, { write: true }),
    (e) => e.status === 403,
  );
});
test("supplier detail permission permits reading but not recording or exporting payments", async () => {
  const f = makePayablesFixture(),
    scope = { ...f.scope, permissions: ["merchandise.details"] };
  await assertAccess(f.db, scope);
  await assert.rejects(
    () => assertAccess(f.db, scope, { write: true }),
    (e) => e.status === 403,
  );
  await assert.rejects(
    () => assertAccess(f.db, scope, { exporting: true }),
    (e) => e.status === 403,
  );
});
