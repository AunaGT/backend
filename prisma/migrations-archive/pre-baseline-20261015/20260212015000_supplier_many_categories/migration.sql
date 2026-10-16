-- Migración: permitir múltiples categorías por proveedor (relación many-to-many)
-- NOTA: Solo cambios estructurales + migración de datos existente.

-- 1) Crear tabla intermedia supplier_categories
CREATE TABLE IF NOT EXISTS "supplier_categories" (
    "supplier_id" UUID NOT NULL,
    "category_id" INTEGER NOT NULL,
    CONSTRAINT "supplier_categories_pkey" PRIMARY KEY ("supplier_id", "category_id")
);

-- 2) Agregar llaves foráneas
DO $$
BEGIN
  -- FK a suppliers
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'supplier_categories_supplier_id_fkey'
  ) THEN
    ALTER TABLE "public"."supplier_categories"
      ADD CONSTRAINT "supplier_categories_supplier_id_fkey"
      FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  -- FK a product_categories
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'supplier_categories_category_id_fkey'
  ) THEN
    ALTER TABLE "public"."supplier_categories"
      ADD CONSTRAINT "supplier_categories_category_id_fkey"
      FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- 3) Migrar datos existentes desde suppliers.category_id -> supplier_categories
INSERT INTO "supplier_categories" ("supplier_id", "category_id")
SELECT s."id", s."category_id"
FROM "suppliers" s
LEFT JOIN "supplier_categories" sc
  ON sc."supplier_id" = s."id" AND sc."category_id" = s."category_id"
WHERE s."category_id" IS NOT NULL
  AND sc."supplier_id" IS NULL;

-- 4) Eliminar FK antigua y columna category_id de suppliers
DO $$
BEGIN
  -- Borrar constraint si existe
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'suppliers_category_id_fkey'
  ) THEN
    ALTER TABLE "public"."suppliers"
      DROP CONSTRAINT "suppliers_category_id_fkey";
  END IF;

  -- Borrar columna category_id si existe
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'suppliers'
      AND column_name = 'category_id'
  ) THEN
    ALTER TABLE "public"."suppliers"
      DROP COLUMN "category_id";
  END IF;
END $$;

