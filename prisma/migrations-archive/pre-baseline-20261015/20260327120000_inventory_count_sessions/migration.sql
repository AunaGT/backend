-- Inventariado: sesiones y líneas de conteo

CREATE TYPE "InventoryCountSessionStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'IN_REVIEW', 'APPROVED', 'CANCELLED');

CREATE TABLE "inventory_count_sessions" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200),
    "status" "InventoryCountSessionStatus" NOT NULL DEFAULT 'DRAFT',
    "scope_json" JSONB,
    "created_by_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "approved_by_id" UUID,
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_count_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_count_lines" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "stock_snapshot" INTEGER NOT NULL,
    "qty_counted" INTEGER,
    "counted_at" TIMESTAMP(3),
    "counted_by_id" UUID,
    "note" VARCHAR(500),

    CONSTRAINT "inventory_count_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_count_lines_session_id_product_id_key" ON "inventory_count_lines"("session_id", "product_id");
CREATE INDEX "inventory_count_lines_session_id_idx" ON "inventory_count_lines"("session_id");
CREATE INDEX "inventory_count_lines_product_id_idx" ON "inventory_count_lines"("product_id");

CREATE INDEX "inventory_count_sessions_status_idx" ON "inventory_count_sessions"("status");
CREATE INDEX "inventory_count_sessions_created_by_id_idx" ON "inventory_count_sessions"("created_by_id");

ALTER TABLE "inventory_count_sessions" ADD CONSTRAINT "inventory_count_sessions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_count_sessions" ADD CONSTRAINT "inventory_count_sessions_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "inventory_count_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_counted_by_id_fkey" FOREIGN KEY ("counted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
