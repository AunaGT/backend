-- Búsqueda global de ventas: trigram GIN para ILIKE/contains y btree en referencia (prefijo V-…)

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "idx_sales_reference_lower"
  ON "sales" (LOWER("reference"))
  WHERE "reference" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_sales_reference_trgm"
  ON "sales" USING gin ("reference" gin_trgm_ops)
  WHERE "reference" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_sales_customer_trgm"
  ON "sales" USING gin ("customer" gin_trgm_ops)
  WHERE "customer" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_sales_customer_nit_trgm"
  ON "sales" USING gin ("customer_nit" gin_trgm_ops)
  WHERE "customer_nit" IS NOT NULL;
