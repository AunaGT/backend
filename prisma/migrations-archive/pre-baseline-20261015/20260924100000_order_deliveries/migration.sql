ALTER TABLE "commercial_documents" ADD COLUMN "fulfillment_mode" VARCHAR(20) NOT NULL DEFAULT 'LEGACY';
ALTER TABLE "commercial_document_lines" ADD COLUMN "qty_invoiced" INTEGER NOT NULL DEFAULT 0;
UPDATE "commercial_document_lines" SET "qty_invoiced" = "qty_fulfilled";
ALTER TABLE "commercial_document_lines" ADD CONSTRAINT "order_line_invoiced_bounds" CHECK ("qty_invoiced" >= 0 AND "qty_invoiced" <= "qty");
CREATE TABLE "order_deliveries" (
  "id" UUID NOT NULL PRIMARY KEY,
  "document_id" UUID NOT NULL REFERENCES "commercial_documents"("id") ON DELETE RESTRICT,
  "request_key" UUID NOT NULL,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notes" VARCHAR(1000),
  "reversed_at" TIMESTAMP(3),
  UNIQUE ("document_id", "request_key")
);
CREATE INDEX "order_deliveries_document_id_created_at_idx" ON "order_deliveries"("document_id", "created_at");
CREATE TABLE "order_delivery_lines" (
  "id" UUID NOT NULL PRIMARY KEY,
  "delivery_id" UUID NOT NULL REFERENCES "order_deliveries"("id") ON DELETE RESTRICT,
  "document_line_id" UUID NOT NULL REFERENCES "commercial_document_lines"("id") ON DELETE RESTRICT,
  "qty" INTEGER NOT NULL CHECK ("qty" > 0),
  "qty_invoiced" INTEGER NOT NULL DEFAULT 0 CHECK ("qty_invoiced" >= 0 AND "qty_invoiced" <= "qty"),
  "unit_cost" DECIMAL(12,2),
  UNIQUE ("delivery_id", "document_line_id")
);
CREATE INDEX "order_delivery_lines_document_line_id_idx" ON "order_delivery_lines"("document_line_id");
