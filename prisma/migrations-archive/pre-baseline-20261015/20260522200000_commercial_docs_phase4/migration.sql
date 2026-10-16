-- Fase 4: apartado blando, entregas parciales, link público

CREATE TYPE "StockReservationKind" AS ENUM ('ORDER', 'QUOTE_SOFT');

ALTER TABLE "commercial_document_lines" ADD COLUMN "qty_fulfilled" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "commercial_documents" ADD COLUMN "public_token" VARCHAR(64);
CREATE UNIQUE INDEX "commercial_documents_public_token_key" ON "commercial_documents"("public_token");

ALTER TABLE "stock_reservations" ADD COLUMN "reservation_kind" "StockReservationKind" NOT NULL DEFAULT 'ORDER';

CREATE TABLE "commercial_document_sales" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "document_id" UUID NOT NULL,
  "sale_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "commercial_document_sales_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "commercial_document_sales_sale_id_key" ON "commercial_document_sales"("sale_id");
CREATE INDEX "idx_commercial_document_sales_document" ON "commercial_document_sales"("document_id");

INSERT INTO "commercial_document_sales" ("document_id", "sale_id", "created_at")
SELECT "id", "sale_id", NOW()
FROM "commercial_documents"
WHERE "sale_id" IS NOT NULL;

ALTER TABLE "commercial_document_sales" ADD CONSTRAINT "commercial_document_sales_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "commercial_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "commercial_document_sales" ADD CONSTRAINT "commercial_document_sales_sale_id_fkey"
  FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "commercial_documents" DROP CONSTRAINT IF EXISTS "commercial_documents_sale_id_fkey";
DROP INDEX IF EXISTS "commercial_documents_sale_id_key";
ALTER TABLE "commercial_documents" DROP COLUMN IF EXISTS "sale_id";
