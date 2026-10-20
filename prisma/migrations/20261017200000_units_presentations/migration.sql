-- Task1: additive/widening only. Apply only in the coordinated Task8 deployment.
-- Generated from the task-local dirty-tree baseline, not HEAD; no old migrations included.
BEGIN;

-- AlterTable
ALTER TABLE "public"."product_stocks" ALTER COLUMN "stock" SET DEFAULT 0,
ALTER COLUMN "stock" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "min_stock" SET DEFAULT 0,
ALTER COLUMN "min_stock" SET DATA TYPE DECIMAL(20,6);

-- AlterTable
ALTER TABLE "public"."product_stock_locations" ALTER COLUMN "stock" SET DEFAULT 0,
ALTER COLUMN "stock" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "min_stock" SET DEFAULT 0,
ALTER COLUMN "min_stock" SET DATA TYPE DECIMAL(20,6);

-- AlterTable
ALTER TABLE "public"."stock_movements" ALTER COLUMN "qty" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "balance" SET DATA TYPE DECIMAL(20,6);

-- AlterTable
ALTER TABLE "public"."stock_transfer_lines" ALTER COLUMN "qty_sent" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "qty_received" SET DATA TYPE DECIMAL(20,6);

-- AlterTable
ALTER TABLE "public"."products" ADD COLUMN     "base_unit_id" UUID,
ADD COLUMN     "unit_metadata_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "default_purchase_presentation_id" UUID,
ADD COLUMN     "default_sale_presentation_id" UUID,
ADD COLUMN     "unit_revision" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "stock" SET DEFAULT 0,
ALTER COLUMN "stock" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "min_stock" SET DEFAULT 0,
ALTER COLUMN "min_stock" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "price" SET DATA TYPE DECIMAL(16,6),
ALTER COLUMN "price_wholesale" SET DATA TYPE DECIMAL(16,6),
ALTER COLUMN "price_promotion" SET DATA TYPE DECIMAL(16,6),
ALTER COLUMN "cost" SET DATA TYPE DECIMAL(24,12);

-- AlterTable
ALTER TABLE "public"."product_lots" ALTER COLUMN "qty_received" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "qty_remaining" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "unit_cost" SET DATA TYPE DECIMAL(24,12);

-- AlterTable
ALTER TABLE "public"."product_bom_lines" ALTER COLUMN "qty_per_unit" SET DEFAULT 1,
ALTER COLUMN "qty_per_unit" SET DATA TYPE DECIMAL(20,6);

-- AlterTable
ALTER TABLE "public"."alerts" ALTER COLUMN "current_stock" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "min_stock" SET DATA TYPE DECIMAL(20,6);

-- AlterTable
ALTER TABLE "public"."sales" ADD COLUMN     "unit_metadata_version" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "items" SET DATA TYPE DECIMAL(20,6);

-- AlterTable
ALTER TABLE "public"."commercial_documents" ADD COLUMN     "unit_metadata_version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "public"."commercial_document_lines" ADD COLUMN     "base_fulfilled" DECIMAL(20,6),
ADD COLUMN     "base_invoiced" DECIMAL(20,6),
ADD COLUMN     "base_qty" DECIMAL(20,6),
ADD COLUMN     "base_unit_cost" DECIMAL(24,12),
ADD COLUMN     "unit_metadata_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "unit_snapshot" JSONB,
ALTER COLUMN "qty" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "qty_fulfilled" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "qty_invoiced" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "unit_price" SET DATA TYPE DECIMAL(30,18);

-- AlterTable
ALTER TABLE "public"."order_delivery_lines" ADD COLUMN     "base_invoiced" DECIMAL(20,6),
ADD COLUMN     "physical_snapshot" JSONB,
ADD COLUMN     "base_qty" DECIMAL(20,6),
ADD COLUMN     "base_unit_cost" DECIMAL(24,12),
ADD COLUMN     "unit_metadata_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "unit_snapshot" JSONB,
ALTER COLUMN "qty" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "qty_invoiced" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "unit_cost" SET DATA TYPE DECIMAL(24,12);

-- AlterTable
ALTER TABLE "public"."stock_reservations" ALTER COLUMN "qty" SET DATA TYPE DECIMAL(20,6);

ALTER TABLE "public"."promotions" ADD COLUMN "quantity_reference" JSONB;

ALTER TABLE "public"."appointment_engagement_lines"
ADD COLUMN "unit_metadata_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "unit_snapshot" JSONB,
ADD COLUMN "base_qty" DECIMAL(20,6),
ADD COLUMN "base_unit_cost" DECIMAL(24,12),
ALTER COLUMN "qty" TYPE DECIMAL(20,6),
ALTER COLUMN "unit_price" TYPE DECIMAL(30,18);

ALTER TABLE public.appointment_engagement_lines DROP CONSTRAINT engagement_line_rules_check;
ALTER TABLE public.appointment_engagement_lines ADD CONSTRAINT engagement_line_rules_check CHECK (
  qty > 0 AND quantity_decimals BETWEEN 0 AND
    CASE WHEN item_kind = 'SERVICE' OR unit_metadata_version = 1 THEN 4 ELSE 6 END
  AND qty = round(qty, quantity_decimals) AND unit_price >= 0 AND line_total >= 0
  AND ((source_document_id IS NULL) = (source_line_id IS NULL))
);
ALTER TABLE public.appointment_engagement_lines ADD CONSTRAINT engagement_line_units_check CHECK (
  unit_metadata_version IN (1, 2)
  AND (base_qty IS NULL OR base_qty BETWEEN 0.000001 AND 99999999.999999)
  AND (unit_metadata_version = 1 OR (
    base_qty IS NOT NULL AND unit_snapshot IS NOT NULL
    AND COALESCE(jsonb_typeof(unit_snapshot) = 'object'
      AND unit_snapshot->'version' = '2'::jsonb
      AND jsonb_typeof(unit_snapshot->'baseUnit') = 'object'
      AND jsonb_typeof(unit_snapshot->'factor') = 'string'
      AND (unit_snapshot->>'factor') ~ '^[0-9]+([.][0-9]+)?$'
      AND jsonb_typeof(unit_snapshot->'roundingDelta') = 'string', false)
  ))
);

-- AlterTable
ALTER TABLE "public"."sale_items" ADD COLUMN     "base_qty" DECIMAL(20,6),
ADD COLUMN     "physical_snapshot" JSONB,
ADD COLUMN     "base_returned" DECIMAL(20,6),
ADD COLUMN     "base_unit_cost" DECIMAL(24,12),
ADD COLUMN     "unit_metadata_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "unit_snapshot" JSONB,
ALTER COLUMN "price" SET DATA TYPE DECIMAL(30,18),
ALTER COLUMN "unit_cost" SET DATA TYPE DECIMAL(24,12),
ALTER COLUMN "qty" SET DATA TYPE DECIMAL(20,6);

-- AlterTable
ALTER TABLE "public"."purchase_logs" ADD COLUMN     "base_qty" DECIMAL(20,6),
ADD COLUMN     "base_unit_cost" DECIMAL(24,12),
ADD COLUMN     "unit_metadata_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "unit_snapshot" JSONB,
ALTER COLUMN "qty" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "cost" SET DATA TYPE DECIMAL(24,12);

-- AlterTable
ALTER TABLE "public"."incoming_merchandise" ADD COLUMN     "unit_metadata_version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "public"."incoming_merchandise_items" ADD COLUMN     "base_qty" DECIMAL(20,6),
ADD COLUMN     "base_unit_cost" DECIMAL(24,12),
ADD COLUMN     "line_total" DECIMAL(12,2),
ADD COLUMN     "unit_metadata_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "unit_snapshot" JSONB,
ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "unit_cost" SET DATA TYPE DECIMAL(24,12);

-- AlterTable
ALTER TABLE "public"."returns" ADD COLUMN     "unit_metadata_version" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "items_count" SET DEFAULT 0,
ALTER COLUMN "items_count" SET DATA TYPE DECIMAL(20,6);

-- AlterTable
ALTER TABLE "public"."return_items" ADD COLUMN     "base_qty" DECIMAL(20,6),
ADD COLUMN     "physical_snapshot" JSONB,
ADD COLUMN     "base_received_qty" DECIMAL(20,6),
ADD COLUMN     "base_restock_qty" DECIMAL(20,6),
ADD COLUMN     "unit_metadata_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "unit_snapshot" JSONB,
ALTER COLUMN "qty_returned" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "received_qty" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "restock_qty" SET DATA TYPE DECIMAL(20,6);

-- AlterTable
ALTER TABLE "public"."return_replacement_items" ADD COLUMN     "base_qty" DECIMAL(20,6),
ADD COLUMN     "base_unit_cost" DECIMAL(24,12),
ADD COLUMN     "unit_metadata_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "unit_snapshot" JSONB,
ALTER COLUMN "qty" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "unit_price" SET DATA TYPE DECIMAL(30,18);

-- AlterTable
ALTER TABLE "public"."promotions" ALTER COLUMN "buy_quantity" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "get_quantity" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "min_quantity" SET DATA TYPE DECIMAL(20,6);

-- AlterTable
ALTER TABLE "public"."inventory_count_lines" ALTER COLUMN "stock_snapshot" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "qty_counted" SET DATA TYPE DECIMAL(20,6),
ALTER COLUMN "qty_counted_secondary" SET DATA TYPE DECIMAL(20,6);

-- CreateTable
CREATE TABLE "public"."measure_units" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "family" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "label" VARCHAR(50) NOT NULL,
    "factor" DECIMAL(24,12) NOT NULL,
    "quantity_decimals" INTEGER NOT NULL DEFAULT 0,
    "is_standard" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "measure_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."product_presentations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "measure_unit_id" UUID,
    "name" VARCHAR(100) NOT NULL,
    "label" VARCHAR(50) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "factor" DECIMAL(24,12) NOT NULL,
    "quantity_decimals" INTEGER NOT NULL DEFAULT 0,
    "purchase_enabled" BOOLEAN NOT NULL DEFAULT true,
    "sale_enabled" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "successor_id" UUID,
    "price" DECIMAL(16,6),
    "price_wholesale" DECIMAL(16,6),
    "price_promotion" DECIMAL(16,6),
    "promotion_valid_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_presentations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."product_barcodes" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "presentation_id" UUID,
    "code" VARCHAR(100) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_barcodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "measure_units_company_id_family_active_idx" ON "public"."measure_units"("company_id", "family", "active");

-- CreateIndex
CREATE UNIQUE INDEX "measure_units_company_id_code_key" ON "public"."measure_units"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "measure_units_company_id_id_key" ON "public"."measure_units"("company_id", "id");

-- CreateIndex
CREATE INDEX "product_presentations_company_id_product_id_active_idx" ON "public"."product_presentations"("company_id", "product_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "product_presentations_company_id_product_id_id_key" ON "public"."product_presentations"("company_id", "product_id", "id");

-- CreateIndex
CREATE INDEX "product_barcodes_company_id_product_id_idx" ON "public"."product_barcodes"("company_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_barcodes_company_id_code_key" ON "public"."product_barcodes"("company_id", "code");

-- AddForeignKey
ALTER TABLE "public"."measure_units" ADD CONSTRAINT "measure_units_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."product_presentations" ADD CONSTRAINT "product_presentations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."product_presentations" ADD CONSTRAINT "product_presentations_company_id_product_id_fkey" FOREIGN KEY ("company_id", "product_id") REFERENCES "public"."products"("company_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."product_presentations" ADD CONSTRAINT "product_presentations_company_id_measure_unit_id_fkey" FOREIGN KEY ("company_id", "measure_unit_id") REFERENCES "public"."measure_units"("company_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."product_presentations" ADD CONSTRAINT "product_presentations_company_id_product_id_successor_id_fkey" FOREIGN KEY ("company_id", "product_id", "successor_id") REFERENCES "public"."product_presentations"("company_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."product_barcodes" ADD CONSTRAINT "product_barcodes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."product_barcodes" ADD CONSTRAINT "product_barcodes_company_id_product_id_fkey" FOREIGN KEY ("company_id", "product_id") REFERENCES "public"."products"("company_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."product_barcodes" ADD CONSTRAINT "product_barcodes_company_id_product_id_presentation_id_fkey" FOREIGN KEY ("company_id", "product_id", "presentation_id") REFERENCES "public"."product_presentations"("company_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."products" ADD CONSTRAINT "products_company_id_base_unit_id_fkey" FOREIGN KEY ("company_id", "base_unit_id") REFERENCES "public"."measure_units"("company_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."products" ADD CONSTRAINT "products_company_id_id_default_purchase_presentation_id_fkey" FOREIGN KEY ("company_id", "id", "default_purchase_presentation_id") REFERENCES "public"."product_presentations"("company_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."products" ADD CONSTRAINT "products_company_id_id_default_sale_presentation_id_fkey" FOREIGN KEY ("company_id", "id", "default_sale_presentation_id") REFERENCES "public"."product_presentations"("company_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- Constraints complement Prisma's FK/unique metadata; legacy snapshots remain untouched.

-- Replace the baseline's count-only checks with a wider contract; retain service rules.
ALTER TABLE public.products DROP CONSTRAINT products_service_fields_check;
ALTER TABLE public.products ADD CONSTRAINT products_service_fields_check CHECK (
  quantity_decimals BETWEEN 0 AND 6
  AND CASE WHEN kind = 'SERVICE' THEN
    quantity_decimals <= 4 AND supplier_id IS NULL AND stock = 0 AND min_stock = 0
    AND cost = 0 AND NOT tracks_expiry AND NOT stock_assembled
    AND service_unit_label IS NOT NULL AND length(btrim(service_unit_label)) BETWEEN 1 AND 50
  ELSE
    supplier_id IS NOT NULL AND service_unit_label IS NULL
    AND (kind <> 'KIT' OR quantity_decimals = 0)
  END
) NOT VALID;

ALTER TABLE public.commercial_document_lines DROP CONSTRAINT commercial_document_lines_commercial_quantity_check;
ALTER TABLE public.commercial_document_lines ADD CONSTRAINT commercial_document_lines_commercial_quantity_check CHECK (
  quantity_decimals BETWEEN 0 AND CASE
    WHEN item_kind = 'SERVICE' THEN 4
    WHEN item_kind = 'KIT' THEN 0
    WHEN unit_metadata_version = 2 THEN 6 ELSE 0 END
  AND qty > 0 AND qty = trunc(qty, quantity_decimals)
  AND length(btrim(item_name)) > 0 AND length(btrim(unit_label)) > 0
) NOT VALID;

ALTER TABLE public.sale_items DROP CONSTRAINT sale_items_commercial_quantity_check;
ALTER TABLE public.sale_items ADD CONSTRAINT sale_items_commercial_quantity_check CHECK (
  quantity_decimals BETWEEN 0 AND CASE
    WHEN item_kind = 'SERVICE' THEN 4
    WHEN item_kind = 'KIT' THEN 0
    WHEN unit_metadata_version = 2 THEN 6 ELSE 0 END
  AND qty > 0 AND qty = trunc(qty, quantity_decimals)
  AND length(btrim(item_name)) > 0 AND length(btrim(unit_label)) > 0
) NOT VALID;

ALTER TABLE public.return_replacement_items DROP CONSTRAINT return_replacement_items_commercial_quantity_check;
ALTER TABLE public.return_replacement_items ADD CONSTRAINT return_replacement_items_commercial_quantity_check CHECK (
  quantity_decimals BETWEEN 0 AND CASE
    WHEN item_kind = 'SERVICE' THEN 4
    WHEN item_kind = 'KIT' THEN 0
    WHEN unit_metadata_version = 2 THEN 6 ELSE 0 END
  AND qty > 0 AND qty = trunc(qty, quantity_decimals)
  AND length(btrim(item_name)) > 0 AND length(btrim(unit_label)) > 0
) NOT VALID;
ALTER TABLE public.measure_units ADD CONSTRAINT measure_unit_definition_check CHECK (
  factor > 0 AND factor <= 99999999.999999999999
  AND quantity_decimals BETWEEN 0 AND 6
  AND code = btrim(code) AND code <> ''
  AND btrim(family) <> '' AND btrim(name) <> '' AND btrim(label) <> ''
);
ALTER TABLE public.product_presentations ADD CONSTRAINT presentation_definition_check CHECK (
  factor > 0 AND factor <= 99999999.999999999999
  AND quantity_decimals BETWEEN 0 AND 6 AND version > 0
  AND btrim(name) <> '' AND btrim(label) <> ''
  AND (successor_id IS NULL OR (successor_id <> id AND NOT active))
  AND (price IS NULL OR price BETWEEN 0 AND 9999999999.99)
  AND (price_wholesale IS NULL OR price_wholesale BETWEEN 0 AND 9999999999.99)
  AND (price_promotion IS NULL OR price_promotion BETWEEN 0 AND 9999999999.99)
);
ALTER TABLE public.product_barcodes ADD CONSTRAINT product_barcode_normalized_check CHECK (code = btrim(code) AND code <> '');
-- NOT VALID avoids assuming legacy rows satisfy new precision metadata before Task8 audits.
ALTER TABLE public.products ADD CONSTRAINT product_unit_precision_check CHECK (
  unit_revision > 0 AND quantity_decimals BETWEEN 0 AND
    CASE WHEN kind = 'SERVICE' THEN 4 WHEN kind = 'KIT' THEN 0 ELSE 6 END
) NOT VALID;
ALTER TABLE public.sales ADD CONSTRAINT sales_unit_version_check CHECK (unit_metadata_version IN (1, 2));
ALTER TABLE public.commercial_documents ADD CONSTRAINT commercial_documents_unit_version_check CHECK (unit_metadata_version IN (1, 2));
ALTER TABLE public.incoming_merchandise ADD CONSTRAINT incoming_merchandise_unit_version_check CHECK (unit_metadata_version IN (1, 2));
ALTER TABLE public.returns ADD CONSTRAINT returns_unit_version_check CHECK (unit_metadata_version IN (1, 2));
ALTER TABLE public.commercial_document_lines ADD CONSTRAINT commercial_document_lines_unit_snapshot_check CHECK (
  unit_metadata_version IN (1, 2)
  AND (base_qty IS NULL OR base_qty BETWEEN 0.000001 AND 99999999.999999)
  AND (unit_metadata_version = 1 OR (
    base_qty IS NOT NULL AND unit_snapshot IS NOT NULL
    AND COALESCE(jsonb_typeof(unit_snapshot) = 'object'
      AND unit_snapshot->'version' = '2'::jsonb
      AND jsonb_typeof(unit_snapshot->'baseUnit') = 'object'
      AND jsonb_typeof(unit_snapshot->'factor') = 'string'
      AND (unit_snapshot->>'factor') ~ '^[0-9]+([.][0-9]+)?$'
      AND jsonb_typeof(unit_snapshot->'roundingDelta') = 'string', false)
  ))
);
ALTER TABLE public.order_delivery_lines ADD CONSTRAINT order_delivery_lines_unit_snapshot_check CHECK (
  unit_metadata_version IN (1, 2)
  AND (base_qty IS NULL OR base_qty BETWEEN 0.000001 AND 99999999.999999)
  AND (unit_metadata_version = 1 OR (
    base_qty IS NOT NULL AND unit_snapshot IS NOT NULL
    AND COALESCE(jsonb_typeof(unit_snapshot) = 'object'
      AND unit_snapshot->'version' = '2'::jsonb
      AND jsonb_typeof(unit_snapshot->'baseUnit') = 'object'
      AND jsonb_typeof(unit_snapshot->'factor') = 'string'
      AND (unit_snapshot->>'factor') ~ '^[0-9]+([.][0-9]+)?$'
      AND jsonb_typeof(unit_snapshot->'roundingDelta') = 'string', false)
  ))
);
ALTER TABLE public.sale_items ADD CONSTRAINT sale_items_unit_snapshot_check CHECK (
  unit_metadata_version IN (1, 2)
  AND (base_qty IS NULL OR base_qty BETWEEN 0.000001 AND 99999999.999999)
  AND (unit_metadata_version = 1 OR (
    base_qty IS NOT NULL AND unit_snapshot IS NOT NULL
    AND COALESCE(jsonb_typeof(unit_snapshot) = 'object'
      AND unit_snapshot->'version' = '2'::jsonb
      AND jsonb_typeof(unit_snapshot->'baseUnit') = 'object'
      AND jsonb_typeof(unit_snapshot->'factor') = 'string'
      AND (unit_snapshot->>'factor') ~ '^[0-9]+([.][0-9]+)?$'
      AND jsonb_typeof(unit_snapshot->'roundingDelta') = 'string', false)
  ))
);
ALTER TABLE public.purchase_logs ADD CONSTRAINT purchase_logs_unit_snapshot_check CHECK (
  unit_metadata_version IN (1, 2)
  AND (base_qty IS NULL OR base_qty BETWEEN 0.000001 AND 99999999.999999)
  AND (unit_metadata_version = 1 OR (
    base_qty IS NOT NULL AND unit_snapshot IS NOT NULL
    AND COALESCE(jsonb_typeof(unit_snapshot) = 'object'
      AND unit_snapshot->'version' = '2'::jsonb
      AND jsonb_typeof(unit_snapshot->'baseUnit') = 'object'
      AND jsonb_typeof(unit_snapshot->'factor') = 'string'
      AND (unit_snapshot->>'factor') ~ '^[0-9]+([.][0-9]+)?$'
      AND jsonb_typeof(unit_snapshot->'roundingDelta') = 'string', false)
  ))
);
ALTER TABLE public.incoming_merchandise_items ADD CONSTRAINT incoming_merchandise_items_unit_snapshot_check CHECK (
  unit_metadata_version IN (1, 2)
  AND (base_qty IS NULL OR base_qty BETWEEN 0.000001 AND 99999999.999999)
  AND (unit_metadata_version = 1 OR (
    base_qty IS NOT NULL AND unit_snapshot IS NOT NULL
    AND COALESCE(jsonb_typeof(unit_snapshot) = 'object'
      AND unit_snapshot->'version' = '2'::jsonb
      AND jsonb_typeof(unit_snapshot->'baseUnit') = 'object'
      AND jsonb_typeof(unit_snapshot->'factor') = 'string'
      AND (unit_snapshot->>'factor') ~ '^[0-9]+([.][0-9]+)?$'
      AND jsonb_typeof(unit_snapshot->'roundingDelta') = 'string', false)
  ))
);
ALTER TABLE public.return_items ADD CONSTRAINT return_items_unit_snapshot_check CHECK (
  unit_metadata_version IN (1, 2)
  AND (base_qty IS NULL OR base_qty BETWEEN 0.000001 AND 99999999.999999)
  AND (unit_metadata_version = 1 OR (
    base_qty IS NOT NULL AND unit_snapshot IS NOT NULL
    AND COALESCE(jsonb_typeof(unit_snapshot) = 'object'
      AND unit_snapshot->'version' = '2'::jsonb
      AND jsonb_typeof(unit_snapshot->'baseUnit') = 'object'
      AND jsonb_typeof(unit_snapshot->'factor') = 'string'
      AND (unit_snapshot->>'factor') ~ '^[0-9]+([.][0-9]+)?$'
      AND jsonb_typeof(unit_snapshot->'roundingDelta') = 'string', false)
  ))
);
ALTER TABLE public.return_replacement_items ADD CONSTRAINT return_replacement_items_unit_snapshot_check CHECK (
  unit_metadata_version IN (1, 2)
  AND (base_qty IS NULL OR base_qty BETWEEN 0.000001 AND 99999999.999999)
  AND (unit_metadata_version = 1 OR (
    base_qty IS NOT NULL AND unit_snapshot IS NOT NULL
    AND COALESCE(jsonb_typeof(unit_snapshot) = 'object'
      AND unit_snapshot->'version' = '2'::jsonb
      AND jsonb_typeof(unit_snapshot->'baseUnit') = 'object'
      AND jsonb_typeof(unit_snapshot->'factor') = 'string'
      AND (unit_snapshot->>'factor') ~ '^[0-9]+([.][0-9]+)?$'
      AND jsonb_typeof(unit_snapshot->'roundingDelta') = 'string', false)
  ))
);
ALTER TABLE public.commercial_document_lines ADD CONSTRAINT commercial_document_lines_base_fulfilled_check CHECK (base_fulfilled IS NULL OR (base_qty IS NOT NULL AND base_fulfilled BETWEEN 0 AND base_qty));
ALTER TABLE public.commercial_document_lines ADD CONSTRAINT commercial_document_lines_base_invoiced_check CHECK (base_invoiced IS NULL OR (base_qty IS NOT NULL AND base_invoiced BETWEEN 0 AND base_qty));
ALTER TABLE public.order_delivery_lines ADD CONSTRAINT order_delivery_lines_base_invoiced_check CHECK (base_invoiced IS NULL OR (base_qty IS NOT NULL AND base_invoiced BETWEEN 0 AND base_qty));
ALTER TABLE public.sale_items ADD CONSTRAINT sale_items_base_returned_check CHECK (base_returned IS NULL OR (base_qty IS NOT NULL AND base_returned BETWEEN 0 AND base_qty));
ALTER TABLE public.commercial_document_lines ADD CONSTRAINT commercial_document_lines_base_cost_check CHECK (base_unit_cost IS NULL OR base_unit_cost >= 0);
ALTER TABLE public.order_delivery_lines ADD CONSTRAINT order_delivery_lines_base_cost_check CHECK (base_unit_cost IS NULL OR base_unit_cost >= 0);
ALTER TABLE public.sale_items ADD CONSTRAINT sale_items_base_cost_check CHECK (base_unit_cost IS NULL OR base_unit_cost >= 0);
ALTER TABLE public.purchase_logs ADD CONSTRAINT purchase_logs_base_cost_check CHECK (base_unit_cost IS NULL OR base_unit_cost >= 0);
ALTER TABLE public.incoming_merchandise_items ADD CONSTRAINT incoming_merchandise_items_base_cost_check CHECK (base_unit_cost IS NULL OR base_unit_cost >= 0);
ALTER TABLE public.return_replacement_items ADD CONSTRAINT return_replacement_items_base_cost_check CHECK (base_unit_cost IS NULL OR base_unit_cost >= 0);

-- Match the server-owned hardware catalogs: no direct Supabase API access.
ALTER TABLE public.measure_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_presentations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_barcodes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.measure_units, public.product_presentations, public.product_barcodes FROM PUBLIC, anon, authenticated, service_role;

-- Task 3: scoped purchase retry identity and frozen commercial line amount.
ALTER TABLE "stock_transfer_lines" ADD COLUMN "unit_snapshot" JSONB;
ALTER TABLE "inventory_count_lines" ADD COLUMN "unit_snapshot" JSONB;
ALTER TABLE "stock_movements" ADD COLUMN "unit_snapshot" JSONB;
ALTER TABLE "incoming_merchandise"
  ADD COLUMN "request_company_id" UUID,
  ADD COLUMN "request_key" VARCHAR(64),
  ADD COLUMN "request_hash" VARCHAR(64),
  ADD COLUMN "request_result" JSONB;
CREATE UNIQUE INDEX "incoming_merchandise_request_key" ON "incoming_merchandise" ("request_company_id", "registered_by", "request_key");
ALTER TABLE "purchase_logs" ADD COLUMN "line_total" DECIMAL(12,2);

ALTER TABLE public.products ADD CONSTRAINT products_unit_version_check CHECK (
  unit_metadata_version IN (1,2) AND (unit_metadata_version=1 OR base_unit_id IS NOT NULL)
);
COMMIT;
