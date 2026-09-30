-- Trazabilidad aditiva para aprobación y liquidación de devoluciones.
CREATE TYPE "ReturnResolution" AS ENUM ('REFUND_ORIGINAL', 'REFUND_CASH', 'REFUND_TRANSFER', 'CUSTOMER_CREDIT', 'EXCHANGE');
CREATE TYPE "ReturnItemDisposition" AS ENUM ('SELLABLE', 'QUARANTINE', 'SCRAP');
CREATE TYPE "ReturnSettlementKind" AS ENUM ('REFUND', 'CREDIT_OFFSET', 'COLLECTION', 'CUSTOMER_CREDIT');

ALTER TABLE "sale_items"
  ADD COLUMN "net_total" DECIMAL(12,2);

ALTER TABLE "returns"
  ADD COLUMN "reference" VARCHAR(30),
  ADD COLUMN "requested_resolution" "ReturnResolution",
  ADD COLUMN "approved_resolution" "ReturnResolution",
  ADD COLUMN "approved_by" UUID,
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "policy_override_reason" TEXT,
  ADD COLUMN "policy_overridden_by" UUID,
  ADD COLUMN "policy_overridden_at" TIMESTAMP(3),
  ADD COLUMN "replacement_sale_id" UUID,
  ADD COLUMN "legacy_stock_reconciled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "legacy_stock_moved" BOOLEAN,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "return_items"
  ADD COLUMN "received_qty" INTEGER,
  ADD COLUMN "restock_qty" INTEGER,
  ADD COLUMN "disposition" "ReturnItemDisposition",
  ADD COLUMN "stock_location_id" UUID;

-- Marca qué aprobaciones históricas ya tocaron existencias. No se asume que
-- estén conciliadas: la API exige revisión explícita antes de completarlas.
UPDATE "returns" r
SET "legacy_stock_moved" = EXISTS (
  SELECT 1
  FROM "stock_movements" sm
  WHERE sm."reason" = 'SALE_RETURN'
    AND sm."ref_type" = 'return'
    AND sm."ref_id" = r."id"::text
);

CREATE TABLE "return_settlements" (
  "id" UUID NOT NULL,
  "return_id" UUID NOT NULL,
  "kind" "ReturnSettlementKind" NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "payment_method_id" INTEGER,
  "cash_register_session_id" UUID,
  "external_reference" VARCHAR(255),
  "registered_by" UUID NOT NULL,
  "idempotency_key" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "return_settlements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "returns_reference_key" ON "returns"("reference");
CREATE UNIQUE INDEX "returns_replacement_sale_id_key" ON "returns"("replacement_sale_id");
CREATE INDEX "return_items_stock_location_id_idx" ON "return_items"("stock_location_id");
CREATE UNIQUE INDEX "return_settlements_return_id_idempotency_key_key" ON "return_settlements"("return_id", "idempotency_key");
CREATE INDEX "return_settlements_return_id_created_at_idx" ON "return_settlements"("return_id", "created_at");
CREATE INDEX "return_settlements_cash_register_session_id_idx" ON "return_settlements"("cash_register_session_id");

ALTER TABLE "returns"
  ADD CONSTRAINT "returns_replacement_sale_id_fkey"
  FOREIGN KEY ("replacement_sale_id") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "return_items"
  ADD CONSTRAINT "return_items_stock_location_id_fkey"
  FOREIGN KEY ("stock_location_id") REFERENCES "stock_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "return_settlements"
  ADD CONSTRAINT "return_settlements_return_id_fkey"
  FOREIGN KEY ("return_id") REFERENCES "returns"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "return_settlements_payment_method_id_fkey"
  FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "return_settlements_cash_register_session_id_fkey"
  FOREIGN KEY ("cash_register_session_id") REFERENCES "cash_register_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
