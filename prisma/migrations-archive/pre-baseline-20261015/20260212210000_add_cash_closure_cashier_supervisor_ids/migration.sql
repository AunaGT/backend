-- Add cashier_id and supervisor_id to cash_closures (FK to users) for traceability

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cash_closures'
      AND column_name = 'cashier_id'
  ) THEN
    ALTER TABLE "public"."cash_closures"
    ADD COLUMN "cashier_id" UUID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cash_closures'
      AND column_name = 'supervisor_id'
  ) THEN
    ALTER TABLE "public"."cash_closures"
    ADD COLUMN "supervisor_id" UUID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cash_closures_cashier_id_fkey'
  ) THEN
    ALTER TABLE "public"."cash_closures"
    ADD CONSTRAINT "cash_closures_cashier_id_fkey"
    FOREIGN KEY ("cashier_id") REFERENCES "public"."users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cash_closures_supervisor_id_fkey'
  ) THEN
    ALTER TABLE "public"."cash_closures"
    ADD CONSTRAINT "cash_closures_supervisor_id_fkey"
    FOREIGN KEY ("supervisor_id") REFERENCES "public"."users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'cash_closures_cashier_id_idx'
      AND n.nspname = 'public'
  ) THEN
    CREATE INDEX "cash_closures_cashier_id_idx"
    ON "public"."cash_closures"("cashier_id");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'cash_closures_supervisor_id_idx'
      AND n.nspname = 'public'
  ) THEN
    CREATE INDEX "cash_closures_supervisor_id_idx"
    ON "public"."cash_closures"("supervisor_id");
  END IF;
END $$;
