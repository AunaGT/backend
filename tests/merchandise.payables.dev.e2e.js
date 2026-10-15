const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { devDbEnabled } = require("./helpers/salesDevFixture.cjs"),
  { withPayablesDevFixture } = require("./helpers/payablesDevFixture.cjs");
test(
  "real Supabase: shared balances, grouped receipt, cancellation and racing payments",
  { skip: !devDbEnabled },
  async () =>
    withPayablesDevFixture(async ({ db, scope, fixture: f, save }) => {
      const api = require("../src/modules/merchandise/payables");
      const before = {
        stock: await db.product.findMany({
          where: { company_id: f.companyId },
          select: { id: true, stock: true, cost: true },
          orderBy: { id: "asc" },
        }),
        moves: await db.stockMovement.count({
          where: { branch_id: f.branchId },
        }),
        journals: await db.journalEntry.count({
          where: { company_id: f.companyId },
        }),
        cash: await db.cashRegisterSession.findMany({
          where: { cashRegister: { branch_id: f.branchId } },
          orderBy: { id: "asc" },
        }),
      };
      const create = (total) => {
        const id = crypto.randomUUID();
        f.retainedEntries.push({ id });
        save();
        return db.incomingMerchandise.create({
          data: {
            id,
            branch_id: f.branchId,
            supplier_id: f.supplierId,
            registered_by: f.userId,
            source: "PURCHASE",
            date: new Date(),
            notes: "QA Cartera flujo",
            items: {
              create: { product_id: f.goodsId, quantity: 1, unit_cost: total },
            },
          },
        });
      };
      const a = await create(60),
        b = await create(40),
        race = await create(100),
        method = await db.paymentMethod.findFirst({
          where: { is_credit: false },
        });
      const input = {
        requestKey: crypto.randomUUID(),
        supplierId: f.supplierId,
        amount: "80.00",
        currencyCode: "GTQ",
        paidAt: new Date().toISOString(),
        paymentMethodId: method.id,
        reference: "QA agrupado",
        notes: null,
        applications: [
          { incomingId: a.id, amount: "60.00", expectedRevision: 0 },
          { incomingId: b.id, amount: "20.00", expectedRevision: 0 },
        ],
      };
      const selection = await api.payableSelection(db, scope, {
        ids: [a.id, b.id],
      });
      assert.deepEqual(selection.map((r) => r.balance).sort(), [
        "40.00",
        "60.00",
      ]);
      const receipt = await api.createSupplierPayment(db, scope, input);
      assert.equal(receipt.applications.length, 2);
      assert.equal(
        (await api.createSupplierPayment(db, scope, input)).id,
        receipt.id,
      );
      const statement = await api.supplierStatement(db, scope, f.supplierId, {
        state: "ALL",
      });
      assert.ok(statement.payments.items.some((r) => r.id === receipt.id));
      assert.ok(statement.audit.items.length >= 2);
      const list = await api.listPayableEntries(db, scope, {
        state: "ALL",
        supplierId: f.supplierId,
        pageSize: 100,
      });
      assert.equal(list.items.find((r) => r.id === a.id).balance, "0.00");
      assert.equal(list.items.find((r) => r.id === b.id).balance, "20.00");
      await api.cancelSupplierPayment(db, scope, receipt.id, {
        reason: "QA corrección agrupada",
      });
      assert.equal(
        (await api.payableSelection(db, scope, { ids: [a.id] }))[0].balance,
        "60.00",
      );
      const make = () => ({
        ...input,
        requestKey: crypto.randomUUID(),
        applications: [
          { incomingId: race.id, amount: "80.00", expectedRevision: 0 },
        ],
      });
      const results = await Promise.allSettled([
        api.createSupplierPayment(db, scope, make()),
        api.createSupplierPayment(db, scope, make()),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        results.filter(
          (r) => r.status === "rejected" && r.reason.status === 409,
        ).length,
        1,
      );
      const after = {
        stock: await db.product.findMany({
          where: { company_id: f.companyId },
          select: { id: true, stock: true, cost: true },
          orderBy: { id: "asc" },
        }),
        moves: await db.stockMovement.count({
          where: { branch_id: f.branchId },
        }),
        journals: await db.journalEntry.count({
          where: { company_id: f.companyId },
        }),
        cash: await db.cashRegisterSession.findMany({
          where: { cashRegister: { branch_id: f.branchId } },
          orderBy: { id: "asc" },
        }),
      };
      assert.deepEqual(after, before);
      const multiple = await create(100);
      await db.incomingMerchandiseItem.create({
        data: {
          incoming_merchandise_id: multiple.id,
          product_id: f.goodsId,
          quantity: 2,
          unit_cost: 25,
        },
      });
      const pay = (amount, revision) =>
        api.createSupplierPayment(db, scope, {
          ...input,
          requestKey: crypto.randomUUID(),
          amount,
          applications: [
            { incomingId: multiple.id, amount, expectedRevision: revision },
          ],
        });
      await pay("45.00", 0);
      await pay("30.00", 1);
      const aggregated = (
        await api.payableSelection(db, scope, { ids: [multiple.id] })
      )[0];
      assert.equal(aggregated.total, "150.00");
      assert.equal(aggregated.documentedPaid, "75.00");
      assert.equal(aggregated.balance, "75.00");
      const individualRace = await create(100),
        individual = require("../src/modules/merchandise/payables/compatibility");
      const mixed = await Promise.allSettled([
        individual.addIndividualPayment(
          db,
          scope,
          individualRace.id,
          { amount: "80.00", paid_at: input.paidAt, expected_revision: 0 },
          crypto.randomUUID(),
        ),
        api.createSupplierPayment(db, scope, {
          ...input,
          requestKey: crypto.randomUUID(),
          applications: [
            {
              incomingId: individualRace.id,
              amount: "80.00",
              expectedRevision: 0,
            },
          ],
        }),
      ]);
      assert.equal(mixed.filter((r) => r.status === "fulfilled").length, 1);
      const negative = await create(100);
      await db.incomingMerchandiseItem.create({
        data: {
          incoming_merchandise_id: negative.id,
          product_id: f.goodsId,
          quantity: 1,
          unit_cost: -1,
        },
      });
      assert.equal(
        (await api.payableSelection(db, scope, { ids: [negative.id] }))[0]
          .status,
        "REVIEW",
      );
      await assert.rejects(
        api.payableSelection(
          db,
          { ...scope, companyId: crypto.randomUUID() },
          { ids: [a.id] },
        ),
      );
      f.flowRuns = [
        ...(f.flowRuns || []),
        { entries: [a.id, b.id, race.id], receipt: receipt.id },
      ];
      save();
    }),
);
