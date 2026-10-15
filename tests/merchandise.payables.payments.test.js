const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto"),
  { makePayablesFixture } = require("./helpers/payablesFixture.cjs"),
  {
    createSupplierPayment,
  } = require("../src/modules/merchandise/payables/payments");
test("grouped supplier payment persists one receipt and two applications with durable exact replay", async () => {
  const f = makePayablesFixture({
      entries: [{ total: "60.00" }, { total: "40.00" }],
    }),
    first = await createSupplierPayment(f.db, f.scope, f.input),
    second = await createSupplierPayment(f.db, f.scope, f.input);
  assert.equal(first.id, second.id);
  assert.equal(f.stored.payments.length, 1);
  assert.deepEqual(
    first.applications.map((a) => a.amount),
    ["60.00", "40.00"],
  );
  assert.deepEqual(
    f.stored.entries.map((e) => e.payment_status),
    ["PAID", "PAID"],
  );
  assert.equal(f.stored.events[0].before.balance, "60.00");
  assert.equal(f.stored.events[0].after.balance, "0.00");
  await assert.rejects(
    () =>
      createSupplierPayment(f.db, f.scope, {
        ...f.input,
        reference: "different",
      }),
    (e) => e.code === "REQUEST_CONFLICT",
  );
});
test("invalid scope, initial load, stale balances and credit are rejected without recording payment", async () => {
  for (const change of [
    (f) => (f.scope.branchId = null),
    (f) => (f.scope.companyId = crypto.randomUUID()),
    (f) => (f.stored.entries[0].source = "INITIAL"),
    (f) => (f.stored.entries[0].supplier_id = crypto.randomUUID()),
    (f) => (f.stored.entries[0].branch_id = crypto.randomUUID()),
    (f) => (f.stored.entries[0].payment_revision = 1),
    (f) => (f.input.paymentMethodId = 2),
    (f) => (f.scope.permissions = ["receivables.manage"]),
  ]) {
    const f = makePayablesFixture();
    change(f);
    await assert.rejects(() => createSupplierPayment(f.db, f.scope, f.input));
    assert.equal(f.stored.payments.length, 0);
  }
});
test("storage failure rolls back parent and applications together", async () => {
  const f = makePayablesFixture();
  f.failNextWrite();
  await assert.rejects(
    () => createSupplierPayment(f.db, f.scope, f.input),
    /Injected/,
  );
  assert.equal(f.stored.payments.length, 0);
  assert.equal(f.stored.entries[0].paymentEntries.length, 0);
});
test("archiving a supplier does not erase the ability to settle existing debt", async () => {
  const f = makePayablesFixture();
  f.db.supplier.findFirst = async ({ where }) =>
    where.id === f.scope.supplierId
      ? null
      : where.id === f.input.supplierId &&
          where.company_id === f.scope.companyId &&
          where.deleted !== false
        ? { id: f.input.supplierId, deleted: true }
        : null;
  const receipt = await createSupplierPayment(f.db, f.scope, f.input);
  assert.equal(receipt.amount, "100.00");
});
