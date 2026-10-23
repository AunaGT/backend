CREATE TABLE "sale_stock_alert_outbox" (
 "id" BIGSERIAL PRIMARY KEY,
 "sale_id" UUID NOT NULL UNIQUE REFERENCES "sales"("id") ON DELETE CASCADE,
 "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
 "branch_id" UUID NOT NULL REFERENCES "branches"("id") ON DELETE CASCADE,
 "product_ids" JSONB NOT NULL,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "attempts" INTEGER NOT NULL DEFAULT 0,
 "last_error" VARCHAR(60),
 CONSTRAINT "sale_stock_alert_outbox_products_check" CHECK (jsonb_typeof("product_ids")='array')
);
CREATE INDEX "sale_stock_alert_outbox_available_at_id_idx" ON "sale_stock_alert_outbox"("available_at","id");
ALTER TABLE "sale_stock_alert_outbox" ENABLE ROW LEVEL SECURITY;
