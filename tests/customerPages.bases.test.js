const test = require("node:test"),
  assert = require("node:assert/strict");
test("all six starting pages publish without missing facts and differ in composition", () => {
  const { resolveBase } = require("../src/modules/config/customerPages/bases"),
    {
      validateDesign,
    } = require("../src/modules/config/customerPages/validate");
  for (const type of ["QUOTE", "ORDER"]) {
    const bases = ["CLASSIC", "CATALOG", "SERVICES"].map((base) =>
      resolveBase(type, base),
    );
    for (const design of bases)
      assert.doesNotThrow(() => validateDesign(design, { mode: "publish" }));
    assert.equal(new Set(bases.map((b) => JSON.stringify(b.nodes))).size, 3);
  }
  assert.throws(
    () => resolveBase("QUOTE", "unknown"),
    (e) => e.status === 422,
  );
});
