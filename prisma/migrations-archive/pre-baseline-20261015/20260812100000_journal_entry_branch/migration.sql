-- Sucursal de origen del asiento contable. NULL = asiento de empresa
-- (manual, cierre anual, importación).
ALTER TABLE "journal_entries" ADD COLUMN "branch_id" UUID;

CREATE INDEX "journal_entries_branch_id_idx" ON "journal_entries"("branch_id");

ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill desde el origen de cada asiento ya contabilizado.
UPDATE "journal_entries" je
SET "branch_id" = s."branch_id"
FROM "sales" s
WHERE je."source_type" = 'SALE' AND je."source_id" = s."id"::text;

UPDATE "journal_entries" je
SET "branch_id" = s."branch_id"
FROM "returns" r
JOIN "sales" s ON s."id" = r."sale_id"
WHERE je."source_type" = 'RETURN' AND je."source_id" = r."id"::text;

UPDATE "journal_entries" je
SET "branch_id" = im."branch_id"
FROM "incoming_merchandise" im
WHERE je."source_type" = 'PURCHASE' AND je."source_id" = im."id"::text;

UPDATE "journal_entries" je
SET "branch_id" = im."branch_id"
FROM "incoming_merchandise_payment_entries" pe
JOIN "incoming_merchandise" im ON im."id" = pe."incoming_merchandise_id"
WHERE je."source_type" = 'PURCHASE_PAYMENT' AND je."source_id" = pe."id"::text;

-- Pagos sintéticos del flujo viejo: source_id = 'pm-synth:<uuid de la compra>'
UPDATE "journal_entries" je
SET "branch_id" = im."branch_id"
FROM "incoming_merchandise" im
WHERE je."source_type" = 'PURCHASE_PAYMENT'
  AND je."source_id" = 'pm-synth:' || im."id"::text;
