const fs = require("node:fs"),
  assert = require("node:assert/strict");
const { withDevDb } = require("./salesDevFixture.cjs");
async function withPayablesDevFixture(run) {
  return withDevDb(async (db) => {
    const file = process.env.AUNA_PAYABLES_LEDGER;
    assert.ok(file, "Provide the owned QA ledger");
    const f = JSON.parse(fs.readFileSync(file, "utf8"));
    const [company, branch, supplier, user, product] = await Promise.all([
      db.company.findUnique({ where: { id: f.companyId } }),
      db.branch.findFirst({
        where: { id: f.branchId, company_id: f.companyId },
      }),
      db.supplier.findFirst({
        where: { id: f.supplierId, company_id: f.companyId },
      }),
      db.user.findUnique({ where: { id: f.userId } }),
      db.product.findFirst({
        where: { id: f.goodsId, company_id: f.companyId },
      }),
    ]);
    assert.match(company?.name || "", /^QA/);
    assert.ok(
      branch && supplier && user && product,
      "Reuse only verified owned development fixtures",
    );
    const save = () =>
      fs.writeFileSync(file, JSON.stringify(f), { mode: 0o600 });
    // Recover IDs from an interrupted run in this owned QA fixture, never delete them.
    f.retainedEntries = await db.incomingMerchandise.findMany({
      where: { branch_id: f.branchId, notes: "QA Cartera flujo" },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    save();
    const scope = {
      companyId: f.companyId,
      branchId: f.branchId,
      branchIds: [f.branchId],
      userId: f.userId,
      isAdmin: true,
      permissions: [],
    };
    return run({ db, scope, fixture: f, save });
  });
}
module.exports = { withPayablesDevFixture };
