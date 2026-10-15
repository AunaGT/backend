const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { makePayablesFixture } = require("./helpers/payablesFixture.cjs"),
  {
    createSupplierPayment,
  } = require("../src/modules/merchandise/payables/payments"),
  {
    cancelSupplierPayment,
    correctHistoricalSettlement,
    cancelLegacyEntry,
  } = require("../src/modules/merchandise/payables/corrections"),
  { balanceOf } = require("../src/modules/merchandise/payables/balance");
test("cancelling a newly PAID purchase reopens the balance once and preserves applications", async () => {
  const f = makePayablesFixture(),
    r = await createSupplierPayment(f.db, f.scope, f.input);
  await cancelSupplierPayment(f.db, f.scope, r.id, {
    reason: "Registro equivocado",
  });
  assert.equal(balanceOf(f.stored.entries[0]).balance, "100.00");
  assert.equal(f.stored.entries[0].legacy_settled_amount, "0.00");
  assert.equal(f.stored.entries[0].paymentEntries.length, 1);
  await cancelSupplierPayment(f.db, f.scope, r.id, {
    reason: "Registro equivocado",
  });
  assert.equal(f.stored.entries[0].payment_revision, 2);
  assert.equal(f.stored.events.length, 2);
  await assert.rejects(
    () =>
      cancelLegacyEntry(
        f.db,
        f.scope,
        f.stored.entries[0].id,
        f.stored.entries[0].paymentEntries[0].id,
        { reason: "Borrar línea" },
      ),
    (e) => e.code === "GROUPED_PAYMENT",
  );
});
test("historical correction clears unknown balance with evidence and never creates a cash payment", async () => {
  const f = makePayablesFixture();
  f.stored.entries[0].payment_balance_review_required = true;
  await correctHistoricalSettlement(f.db, f.scope, f.stored.entries[0].id, {
    amount: "20.00",
    expectedRevision: 0,
    reason: "Verificado con documento anterior",
  });
  assert.equal(balanceOf(f.stored.entries[0]).balance, "80.00");
  assert.equal(f.stored.payments.length, 0);
  assert.equal(f.stored.events.length, 1);
  await assert.rejects(
    () =>
      correctHistoricalSettlement(f.db, f.scope, f.stored.entries[0].id, {
        amount: "100.00",
        expectedRevision: 0,
        reason: "Repetido",
      }),
    (e) => e.code === "STALE_BALANCE",
  );
});
test("a historical marker cannot hide malformed document items", async () => {
  const f = makePayablesFixture();
  f.stored.entries[0].items.push({ quantity: 1, unit_cost: "-1.00" });
  f.stored.entries[0].payment_balance_review_required = true;
  await assert.rejects(
    correctHistoricalSettlement(f.db, f.scope, f.stored.entries[0].id, {
      amount: "0.00",
      expectedRevision: 0,
      reason: "Verificar documento",
    }),
    (e) => e.code === "BALANCE_REVIEW",
  );
  assert.equal(f.stored.entries[0].payment_revision, 0);
});
