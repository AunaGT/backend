-- Add reference column to sales (human-readable id: V-000001, V-000002, ...)
-- New sales get reference on create; existing rows remain NULL.

ALTER TABLE "public"."sales" ADD COLUMN IF NOT EXISTS "reference" VARCHAR(20);

CREATE UNIQUE INDEX IF NOT EXISTS "sales_reference_key" ON "public"."sales"("reference") WHERE "reference" IS NOT NULL;
