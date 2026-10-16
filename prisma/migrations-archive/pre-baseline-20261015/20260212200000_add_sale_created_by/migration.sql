-- Add created_by column to sales and link to users

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sales'
      AND column_name = 'created_by'
  ) THEN
    ALTER TABLE "public"."sales"
    ADD COLUMN "created_by" UUID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sales_created_by_fkey'
  ) THEN
    ALTER TABLE "public"."sales"
    ADD CONSTRAINT "sales_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'sales_created_by_idx'
      AND n.nspname = 'public'
  ) THEN
    CREATE INDEX "sales_created_by_idx"
    ON "public"."sales"("created_by");
  END IF;
END $$;

