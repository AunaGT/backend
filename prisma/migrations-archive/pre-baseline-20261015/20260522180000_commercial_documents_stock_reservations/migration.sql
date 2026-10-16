-- Cotizaciones, pedidos y reservas de stock (Fase 0)

CREATE TYPE "CommercialDocType" AS ENUM ('QUOTE', 'ORDER');
CREATE TYPE "CommercialDocStatus" AS ENUM (
  'DRAFT',
  'SENT',
  'ACCEPTED',
  'REJECTED',
  'CONFIRMED',
  'PARTIALLY_FULFILLED',
  'FULFILLED',
  'CANCELLED',
  'EXPIRED'
);
CREATE TYPE "StockReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED', 'EXPIRED');

CREATE TABLE "commercial_documents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "reference" VARCHAR(20),
  "doc_type" "CommercialDocType" NOT NULL,
  "status" "CommercialDocStatus" NOT NULL DEFAULT 'DRAFT',
  "valid_until" TIMESTAMP(3),
  "customer" VARCHAR(150),
  "customer_nit" VARCHAR(50),
  "is_final_consumer" BOOLEAN NOT NULL DEFAULT true,
  "customer_contact_id" UUID,
  "sales_channel" "SalesChannel" NOT NULL DEFAULT 'WHOLESALE',
  "subtotal" DECIMAL(12,2),
  "discount_total" DECIMAL(12,2),
  "total" DECIMAL(12,2) NOT NULL,
  "notes" TEXT,
  "converted_from_id" UUID,
  "sale_id" UUID,
  "created_by" UUID,
  "confirmed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "commercial_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "commercial_document_lines" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "document_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "qty" INTEGER NOT NULL,
  "unit_price" DECIMAL(12,2) NOT NULL,
  "line_total" DECIMAL(12,2) NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "commercial_document_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_reservations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "product_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "document_line_id" UUID NOT NULL,
  "qty" INTEGER NOT NULL,
  "status" "StockReservationStatus" NOT NULL DEFAULT 'ACTIVE',
  "expires_at" TIMESTAMP(3),
  "created_by" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "released_at" TIMESTAMP(3),
  "consumed_at" TIMESTAMP(3),

  CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "commercial_documents_reference_key" ON "commercial_documents"("reference");
CREATE UNIQUE INDEX "commercial_documents_sale_id_key" ON "commercial_documents"("sale_id");
CREATE INDEX "idx_commercial_docs_type_status_created" ON "commercial_documents"("doc_type", "status", "created_at" DESC);
CREATE INDEX "idx_commercial_docs_customer_contact" ON "commercial_documents"("customer_contact_id");
CREATE INDEX "idx_commercial_doc_lines_document" ON "commercial_document_lines"("document_id");
CREATE INDEX "idx_commercial_doc_lines_product" ON "commercial_document_lines"("product_id");
CREATE INDEX "idx_stock_reservations_product_status" ON "stock_reservations"("product_id", "status");
CREATE INDEX "idx_stock_reservations_document_status" ON "stock_reservations"("document_id", "status");

ALTER TABLE "commercial_documents" ADD CONSTRAINT "commercial_documents_customer_contact_id_fkey"
  FOREIGN KEY ("customer_contact_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "commercial_documents" ADD CONSTRAINT "commercial_documents_converted_from_id_fkey"
  FOREIGN KEY ("converted_from_id") REFERENCES "commercial_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "commercial_documents" ADD CONSTRAINT "commercial_documents_sale_id_fkey"
  FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "commercial_documents" ADD CONSTRAINT "commercial_documents_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "commercial_document_lines" ADD CONSTRAINT "commercial_document_lines_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "commercial_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "commercial_document_lines" ADD CONSTRAINT "commercial_document_lines_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "commercial_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_document_line_id_fkey"
  FOREIGN KEY ("document_line_id") REFERENCES "commercial_document_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
