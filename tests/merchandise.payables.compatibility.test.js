const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { makePayablesFixture } = require("./helpers/payablesFixture.cjs");
const {
  addIndividualPayment,
  changePaymentConditions,
  shapePaymentBalance,
  settleNewPurchase,
} = require("../src/modules/merchandise/payables/compatibility");
const { cancelLegacyEntry } = require("../src/modules/merchandise/payables");
test('public merchandise handlers share balances and return a grouped-payment conflict without deleting history',async()=>{
 const f=makePayablesFixture(),dbPath=require.resolve('../src/models/prisma'),controllerPath=require.resolve('../src/modules/merchandise/controller'),previous=require.cache[dbPath]
 require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{prisma:f.db,prismaTransaction:f.db}}
 delete require.cache[controllerPath]
 try{
  const controller=require(controllerPath),row=f.stored.entries[0],req={params:{id:row.id},companyId:f.scope.companyId,branchId:f.scope.branchId,branchIds:f.scope.branchIds,user:{sub:f.scope.userId,permissions:f.scope.permissions},body:{amount:'25.00',paid_at:'2026-10-14T12:00:00Z',expected_revision:0},get:()=>crypto.randomUUID()}
  let payload,status=200;const res={status:n=>{status=n;return res},json:data=>{payload=data}},next=e=>{throw e}
  await controller.addPaymentEntry(req,res,next);assert.equal(payload.amount_pending,75);assert.equal(payload.amount_paid_total,25);assert.ok(payload.payment_entries[0].supplier_payment_id)
  req.params.entryId=payload.payment_entries[0].id;req.body={reason:'Corrección QA'};await controller.deletePaymentEntry(req,res,next)
  assert.equal(status,409);assert.equal(payload.code,'GROUPED_PAYMENT');assert.equal(f.stored.entries[0].paymentEntries.length,1)
  await controller.getById(req,res,next);assert.equal(payload.amount_pending,75)
 }finally{delete require.cache[controllerPath];if(previous)require.cache[dbPath]=previous;else delete require.cache[dbPath]}
})
test("individual payment creates a durable receipt; cancelled history does not reduce balance", async () => {
  const f = makePayablesFixture(),
    id = f.stored.entries[0].id,
    key = crypto.randomUUID(),
    body = {
      amount: "25.00",
      paid_at: "2026-10-14T12:00:00Z",
      expected_revision: 0,
    };
  const receipt = await addIndividualPayment(f.db, f.scope, id, body, key);
  assert.equal(receipt.applications.length, 1);
  assert.equal(receipt.amount, "25.00");
  await addIndividualPayment(f.db, f.scope, id, body, key);
  assert.equal(f.stored.payments.length, 1);
  let data = shapePaymentBalance(f.stored.entries[0]);
  assert.equal(data.amount_pending, 75);
  assert.equal(data.amount_paid_total, 25);
  await assert.rejects(
    cancelLegacyEntry(
      f.db,
      f.scope,
      id,
      f.stored.entries[0].paymentEntries[0].id,
      { reason: "Corrección QA" },
    ),
    (e) =>
      e.code === "GROUPED_PAYMENT" && e.data.supplierPaymentId === receipt.id,
  );
  f.stored.entries[0].paymentEntries[0].cancelled_at = new Date();
  data = shapePaymentBalance(f.stored.entries[0]);
  assert.equal(data.amount_pending, 100);
  assert.equal(data.amount_paid_total, 0);
});
test("manual PAID pays the actual balance; PENDING cannot hide payments and PARTIAL cannot invent one", async () => {
  const f = makePayablesFixture(),
    id = f.stored.entries[0].id;
  await assert.rejects(
    changePaymentConditions(f.db, f.scope, id, { payment_status: "PARTIAL" }),
    /monto|abono/i,
  );
  await changePaymentConditions(
    f.db,
    f.scope,
    id,
    { payment_status: "PAID", paid_at: "2026-10-14T12:00:00Z" },
    crypto.randomUUID(),
  );
  assert.equal(f.stored.payments.length, 1);
  assert.equal(shapePaymentBalance(f.stored.entries[0]).amount_pending, 0);
  await assert.rejects(
    changePaymentConditions(f.db, f.scope, id, { payment_status: "PENDING" }),
    (e) => e.status === 409,
  );
});
test("legacy settlement is separate from documented payments and scope is enforced", async () => {
  const f = makePayablesFixture({
    entries: [
      {
        total: "100.00",
        legacy_settled_amount: "100.00",
        payment_status: "PAID",
      },
    ],
  });
  const result = shapePaymentBalance(f.stored.entries[0]);
  assert.equal(result.amount_paid_total, 0);
  assert.equal(result.legacy_settled_amount, 100);
  assert.equal(result.amount_pending, 0);
  await assert.rejects(
    addIndividualPayment(
      f.db,
      { ...f.scope, branchId: crypto.randomUUID() },
      f.stored.entries[0].id,
      { amount: "1" },
      crypto.randomUUID(),
    ),
    (e) => [403, 404].includes(e.status),
  );
});
test("new paid PURCHASE records money, while INITIAL never creates a disbursement", async () => {
  const f = makePayablesFixture(),
    row = f.stored.entries[0];
  const settled = await settleNewPurchase(f.db, f.scope, row, {
    payment_status: "PAID",
    paid_at: "2026-10-14T12:00:00Z",
  });
  assert.equal(f.stored.payments.length, 1);
  assert.equal(settled.payment_status, 'PAID');
  assert.equal(f.stored.entries[0].legacy_settled_amount, "0.00");
  await settleNewPurchase(
    f.db,
    f.scope,
    { ...row, source: "INITIAL" },
    { payment_status: "PAID" },
  );
  assert.equal(f.stored.payments.length, 1);
});
