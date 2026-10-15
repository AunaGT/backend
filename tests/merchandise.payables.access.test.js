const test = require("node:test"),
  assert = require("node:assert/strict"),
  { resolveEffectiveModules } = require("../src/modules/platform/registry");
test("Cartera remains available without sales, without enabling sales or merchandise", () => {
  const modules = resolveEffectiveModules([
      { module_code: "sales", status: "DISABLED" },
      { module_code: "merchandise", status: "DISABLED" },
    ]),
    by = Object.fromEntries(modules.map((m) => [m.code, m]));
  assert.equal(by.receivables.effectiveEnabled, true);
  assert.equal(by.sales.effectiveEnabled, false);
  assert.equal(by.merchandise.effectiveEnabled, false);
});
