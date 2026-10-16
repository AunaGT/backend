-- Índices compuestos alineados con listados recientes (contactos, mercancía, inventariado, purchase_logs)
-- y búsqueda de ventas por cliente (nombre/NIT case-insensitive en GET /sales?customer_contact_id=)

-- purchase_logs: (supplier_id, date) sustituye el índice solo por supplier_id para el prefijo
DROP INDEX IF EXISTS "purchase_logs_supplier_id_idx";
DROP INDEX IF EXISTS "idx_purchase_logs_supplier_id"; -- script docs/scripts/add-performance-indexes.sql (nombre legado)

CREATE INDEX "idx_purchase_logs_supplier_date" ON "purchase_logs" ("supplier_id", "date" DESC);

CREATE INDEX "idx_sales_status_id_date_desc" ON "sales" ("status_id", "date" DESC);

DROP INDEX IF EXISTS "incoming_merchandise_supplier_id_idx";
DROP INDEX IF EXISTS "idx_incoming_merchandise_supplier_id";

CREATE INDEX "idx_incoming_merchandise_supplier_date" ON "incoming_merchandise" ("supplier_id", "date" DESC);

DROP INDEX IF EXISTS "suppliers_party_type_idx";

CREATE INDEX "idx_suppliers_party_type_name" ON "suppliers" ("party_type", "name");

DROP INDEX IF EXISTS "inventory_count_sessions_status_idx";

CREATE INDEX "idx_inventory_count_sessions_created_at" ON "inventory_count_sessions" ("created_at" DESC);

CREATE INDEX "idx_inventory_count_sessions_status_created" ON "inventory_count_sessions" ("status", "created_at" DESC);

-- No declarados en schema.prisma (expresión): acelera OR por customer / customer_nit con modo insensitive
CREATE INDEX IF NOT EXISTS "idx_sales_customer_lower" ON "sales" (LOWER("customer")) WHERE "customer" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_sales_customer_nit_lower" ON "sales" (LOWER("customer_nit")) WHERE "customer_nit" IS NOT NULL;
