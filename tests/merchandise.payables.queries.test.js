const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { makePayablesFixture } = require("./helpers/payablesFixture.cjs"),
  {
    listPayableEntries,
    payablesSummary,
  } = require("../src/modules/merchandise/payables/queries");
test("entry query is scoped, paginated and returns historical totals without cost data from current product", async () => {
  const f = makePayablesFixture();
  let queries = 0;
  f.db.$queryRaw = async (sql) => {
    queries++;
    assert.ok(sql.values.includes(f.scope.companyId));
    assert.ok(sql.values.includes(f.scope.branchId));
    return queries === 1
      ? [
          {
            id: "a",
            supplier_id: "p",
            supplier_name: "QA",
            branch_id: f.scope.branchId,
            branch_name: "Principal",
            date: new Date(),
            due_date: null,
            total_amount: "100.00",
            documented_paid: "25.00",
            legacy_settled_amount: "0.00",
            payment_revision: 2,
            payment_balance_review_required: false,
            source: "PURCHASE",
            total_count: 1n,
          },
        ]
      : [];
  };
  const result = await listPayableEntries(f.db, f.scope, {
    page: 1,
    pageSize: 10,
  });
  assert.equal(result.totalItems, 1);
  assert.equal(result.items[0].balance, "75.00");
  assert.equal(result.items[0].dueDate, null);
  assert.equal(result.items[0].overdue, false);
  assert.equal(Object.hasOwn(result.items[0], "cost"), false);
});
test("summary explicitly indicates incomplete totals when a historic balance needs review", async () => {
  const f = makePayablesFixture();
  f.db.$queryRaw = async () => [
    {
      pending: "100.00",
      overdue: "30.00",
      upcoming: "40.00",
      supplier_count: 2n,
      review_count: 1n,
    },
  ];
  const result = await payablesSummary(f.db, f.scope, {});
  assert.equal(result.pending, "100.00");
  assert.equal(result.reviewCount, 1);
  assert.equal(result.complete, false);
});
