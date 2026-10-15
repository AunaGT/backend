const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { Prisma } = require("@prisma/client");
const model = (name) =>
  Prisma.dmmf.datamodel.models.find((m) => m.name === name);
test("generated client supports durable supplier receipts and nullable legacy applications", () => {
  const receipt = model("SupplierPayment");
  assert.ok(
    receipt,
    "SupplierPayment is required to persist idempotency across restarts",
  );
  assert.ok(
    receipt.uniqueFields.some(
      (fields) => fields.join(",") === "company_id,registered_by,request_key",
    ),
  );
  const entry = model("IncomingMerchandisePaymentEntry");
  assert.equal(
    entry.fields.find((f) => f.name === "supplier_payment_id")?.isRequired,
    false,
  );
  for (const key of ["cancelled_at", "cancelled_by", "cancel_reason"])
    assert.ok(entry.fields.find((f) => f.name === key));
});
test("generated client distinguishes settlement evidence from current status and retains correction history", () => {
  const entry = model("IncomingMerchandise");
  for (const key of [
    "legacy_settled_amount",
    "payment_revision",
    "payment_balance_review_required",
  ])
    assert.ok(
      entry.fields.find((f) => f.name === key),
      key,
    );
  const audit = model("MerchandisePaymentAuditEvent");
  assert.ok(audit);
  for (const key of ["before", "after", "reason", "actor_id"])
    assert.ok(audit.fields.find((f) => f.name === key));
});
