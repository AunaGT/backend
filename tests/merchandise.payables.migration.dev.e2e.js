const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { withDevDb, devDbEnabled } = require("./helpers/salesDevFixture.cjs");
const contextFile = process.env.AUNA_PAYABLES_LEDGER;
test(
  "supplier payment migration preserves historical paid records without inventing receipts",
  { skip: !devDbEnabled },
  async () =>
    withDevDb(async (db) => {
      if (process.env.AUNA_PAYABLES_PREPARE === "YES") {
        const fixture = JSON.parse(
          fs.readFileSync("/tmp/auna-barcode-qa-d5nDcJ/ledger.json", "utf8"),
        );
        const company = await db.company.findUnique({
          where: { id: fixture.companyId },
          select: { name: true },
        });
        assert.match(company.name, /^QA/);
        const directory = fs.mkdtempSync(
          path.join(os.tmpdir(), "auna-payables-qa-"),
        );
        fs.chmodSync(directory, 0o700);
        const snapshot = {
          merchandise: await db.$queryRaw`SELECT * FROM incoming_merchandise`,
          applications:
            await db.$queryRaw`SELECT * FROM incoming_merchandise_payment_entries`,
        };
        fs.writeFileSync(
          path.join(directory, "before.json"),
          JSON.stringify(snapshot),
          { mode: 0o600 },
        );
        const cases = [
          ["PAID", 0, "100", false],
          ["PAID", 20, "80", false],
          ["PARTIAL", 0, "0", true],
          ["PARTIAL", 30, "0", false],
          ["PAID", 120, "0", true],
          ["PENDING", 0, "0", false],
        ];
        const ledger = {
          ...fixture,
          cases: cases.map(([status, paid, legacy, review]) => ({
            id: crypto.randomUUID(),
            status,
            paid,
            legacy,
            review,
          })),
          createdAt: new Date().toISOString(),
        };
        fs.writeFileSync(
          path.join(directory, "ledger.json"),
          JSON.stringify(ledger),
          { mode: 0o600 },
        );
        await db.$transaction(
          async (tx) => {
            for (const c of ledger.cases) {
              await tx.$executeRaw`INSERT INTO incoming_merchandise(id,branch_id,supplier_id,registered_by,date,source,payment_status,notes) VALUES(${c.id}::uuid,${fixture.branchId}::uuid,${fixture.supplierId}::uuid,${fixture.userId}::uuid,NOW(),'PURCHASE',${c.status}::"MerchandisePaymentStatus",'QA Cartera migración')`;
              await tx.$executeRaw`INSERT INTO incoming_merchandise_items(id,incoming_merchandise_id,product_id,quantity,unit_cost) VALUES(${crypto.randomUUID()}::uuid,${c.id}::uuid,${fixture.goodsId}::uuid,1,100)`;
              if (c.paid)
                await tx.$executeRaw`INSERT INTO incoming_merchandise_payment_entries(id,incoming_merchandise_id,amount,paid_at,registered_by) VALUES(${crypto.randomUUID()}::uuid,${c.id}::uuid,${c.paid},NOW(),${fixture.userId}::uuid)`;
            }
          },
          { timeout: 30000 },
        );
        console.log(
          "Payables QA ledger: " + path.join(directory, "ledger.json"),
        );
        return;
      }
      assert.ok(
        contextFile,
        "AUNA_PAYABLES_LEDGER identifies the owned migration fixtures",
      );
      const ledger = JSON.parse(fs.readFileSync(contextFile, "utf8"));
      for (const c of ledger.cases) {
        const row = await db.incomingMerchandise.findUnique({
          where: { id: c.id },
          include: { paymentEntries: true, items: true },
        });
        assert.equal(Number(row.legacy_settled_amount), Number(c.legacy));
        assert.equal(row.payment_status, c.status);
        assert.equal(row.payment_balance_review_required, c.review);
        assert.equal(row.paymentEntries.length, c.paid ? 1 : 0);
        assert.equal(
          row.paymentEntries.filter((a) => a.supplier_payment_id).length,
          0,
        );
        assert.equal(row.items[0].quantity, 1);
        assert.equal(Number(row.items[0].unit_cost), 100);
        if (c.paid) assert.equal(Number(row.paymentEntries[0].amount), c.paid);
      }
    }),
);
