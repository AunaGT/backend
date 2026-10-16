-- Inventariado avanzado: doble conteo, doble aprobación, motivo de envío

ALTER TYPE "InventoryCountSessionStatus" ADD VALUE 'PENDING_SECOND_APPROVAL' BEFORE 'APPROVED';

ALTER TABLE "inventory_count_sessions" ADD COLUMN "dual_approval" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "inventory_count_sessions" ADD COLUMN "submit_reason" TEXT;
ALTER TABLE "inventory_count_sessions" ADD COLUMN "first_approved_at" TIMESTAMP(3);
ALTER TABLE "inventory_count_sessions" ADD COLUMN "first_approved_by_id" UUID;
ALTER TABLE "inventory_count_sessions" ADD COLUMN "first_approval_reason" TEXT;
ALTER TABLE "inventory_count_sessions" ADD COLUMN "final_approval_reason" TEXT;

ALTER TABLE "inventory_count_sessions"
ADD CONSTRAINT "inventory_count_sessions_first_approved_by_id_fkey"
FOREIGN KEY ("first_approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inventory_count_lines" ADD COLUMN "qty_counted_secondary" INTEGER;
ALTER TABLE "inventory_count_lines" ADD COLUMN "counted_secondary_at" TIMESTAMP(3);
ALTER TABLE "inventory_count_lines" ADD COLUMN "counted_secondary_by_id" UUID;

ALTER TABLE "inventory_count_lines"
ADD CONSTRAINT "inventory_count_lines_counted_secondary_by_id_fkey"
FOREIGN KEY ("counted_secondary_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
