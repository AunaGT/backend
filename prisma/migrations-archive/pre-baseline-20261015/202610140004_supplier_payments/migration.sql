CREATE TYPE "SupplierPaymentStatus" AS ENUM ('POSTED','CANCELLED');
ALTER TABLE "incoming_merchandise"
  ADD COLUMN "legacy_settled_amount" DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (legacy_settled_amount>=0),
  ADD COLUMN "payment_revision" INTEGER NOT NULL DEFAULT 0 CHECK (payment_revision>=0),
  ADD COLUMN "payment_balance_review_required" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "supplier_payments" (
  "id" UUID PRIMARY KEY,
  "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "branch_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL CHECK(amount>0),
  "currency_code" VARCHAR(3) NOT NULL,
  "paid_at" TIMESTAMP(3) NOT NULL,
  "payment_method_id" INTEGER REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "reference" VARCHAR(255), "notes" TEXT,
  "registered_by" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "request_key" UUID NOT NULL, "request_hash" VARCHAR(64) NOT NULL,
  "status" "SupplierPaymentStatus" NOT NULL DEFAULT 'POSTED',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelled_at" TIMESTAMP(3),
  "cancelled_by" UUID REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "cancel_reason" VARCHAR(500),
  FOREIGN KEY("company_id","branch_id") REFERENCES "branches"("company_id","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY("company_id","supplier_id") REFERENCES "suppliers"("company_id","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE("company_id","registered_by","request_key")
);
ALTER TABLE "incoming_merchandise_payment_entries"
  ADD COLUMN "supplier_payment_id" UUID REFERENCES "supplier_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN "cancelled_at" TIMESTAMP(3),
  ADD COLUMN "cancelled_by" UUID REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN "cancel_reason" VARCHAR(500),
  ADD CONSTRAINT "incoming_merchandise_payment_entries_supplier_payment_id_inc_key" UNIQUE ("supplier_payment_id","incoming_merchandise_id");
CREATE TABLE "merchandise_payment_audit_events" (
  "id" UUID PRIMARY KEY,
  "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "incoming_merchandise_id" UUID NOT NULL REFERENCES "incoming_merchandise"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "actor_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "action" VARCHAR(50) NOT NULL,"reason" VARCHAR(500),
  "before" JSONB NOT NULL,"after" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "supplier_payments_company_id_supplier_id_paid_at_idx" ON "supplier_payments"("company_id","supplier_id","paid_at" DESC);
CREATE INDEX "supplier_payments_branch_id_paid_at_idx" ON "supplier_payments"("branch_id","paid_at" DESC);
CREATE INDEX "incoming_merchandise_branch_id_due_date_idx" ON "incoming_merchandise"("branch_id","due_date");
CREATE INDEX "merchandise_payment_audit_events_incoming_merchandise_id_creat_idx" ON "merchandise_payment_audit_events"("incoming_merchandise_id","created_at" DESC);
CREATE INDEX "merchandise_payment_audit_events_company_id_created_at_idx" ON "merchandise_payment_audit_events"("company_id","created_at" DESC);
-- Historical closure is evidence from the old record, not a new cash payment.
WITH totals AS (
 SELECT incoming_merchandise_id,SUM(quantity*unit_cost) AS total,COUNT(*) AS n
 FROM incoming_merchandise_items GROUP BY incoming_merchandise_id
), paid AS (
 SELECT incoming_merchandise_id,SUM(amount) AS amount
 FROM incoming_merchandise_payment_entries GROUP BY incoming_merchandise_id
), classified AS (
 SELECT m.id,m.payment_status,COALESCE(t.total,0) AS total,COALESCE(t.n,0) AS n,COALESCE(p.amount,0) AS paid
 FROM incoming_merchandise m LEFT JOIN totals t ON t.incoming_merchandise_id=m.id LEFT JOIN paid p ON p.incoming_merchandise_id=m.id
)
UPDATE incoming_merchandise m SET
 legacy_settled_amount=CASE WHEN c.payment_status='PAID' AND c.n>0 AND c.total>=c.paid AND c.paid>=0 AND c.total-c.paid<=9999999999.99 THEN c.total-c.paid ELSE 0 END,
 payment_balance_review_required=c.n=0 OR c.total<0 OR c.paid<0 OR c.paid>c.total OR (c.payment_status='PARTIAL' AND c.paid=0) OR (c.payment_status='PAID' AND c.total-c.paid>9999999999.99)
FROM classified c WHERE m.id=c.id;
-- Only authenticated backend APIs expose these administrative payment records.
ALTER TABLE "supplier_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "merchandise_payment_audit_events" ENABLE ROW LEVEL SECURITY;
