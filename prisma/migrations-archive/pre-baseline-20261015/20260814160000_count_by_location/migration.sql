-- El conteo físico pasa a ser por ubicación: una línea por (producto, ubicación).

ALTER TABLE "public"."inventory_count_sessions" ADD COLUMN "warehouse_id" UUID;
ALTER TABLE "public"."inventory_count_lines" ADD COLUMN "location_id" UUID;

-- Toda sucursal necesita al menos una ubicación para poder ubicar sus líneas
-- viejas (las sucursales creadas después de la migración de almacenes no la tienen).
INSERT INTO "public"."warehouses" (id, branch_id, name, code, kind, is_default, is_receiving, dispatch_priority, active, created_at, updated_at)
SELECT gen_random_uuid(), b.id, 'Principal', 'PRIN', 'BODEGA', true, true, 10, true, now(), now()
FROM "public"."branches" b
WHERE NOT EXISTS (SELECT 1 FROM "public"."warehouses" w WHERE w.branch_id = b.id);

INSERT INTO "public"."stock_locations" (id, warehouse_id, code, name, is_default, pickable, dispatch_priority, active, created_at)
SELECT gen_random_uuid(), w.id, 'GENERAL', 'General', true, true, 10, true, now()
FROM "public"."warehouses" w
WHERE NOT EXISTS (SELECT 1 FROM "public"."stock_locations" l WHERE l.warehouse_id = w.id);

-- Las líneas históricas quedan en la ubicación por defecto de su sucursal.
UPDATE "public"."inventory_count_lines" cl
SET location_id = (
  SELECT l.id
  FROM "public"."stock_locations" l
  JOIN "public"."warehouses" w ON w.id = l.warehouse_id
  JOIN "public"."inventory_count_sessions" s ON s.id = cl.session_id
  WHERE w.branch_id = s.branch_id
  ORDER BY w.is_default DESC, l.is_default DESC, w.dispatch_priority, l.dispatch_priority, l.code
  LIMIT 1
)
WHERE cl.location_id IS NULL;

ALTER TABLE "public"."inventory_count_lines" ALTER COLUMN "location_id" SET NOT NULL;

ALTER TABLE "public"."inventory_count_sessions"
  ADD CONSTRAINT "inventory_count_sessions_warehouse_id_fkey"
  FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."inventory_count_lines"
  ADD CONSTRAINT "inventory_count_lines_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX IF EXISTS "public"."inventory_count_lines_session_id_product_id_key";
CREATE UNIQUE INDEX "inventory_count_lines_session_id_product_id_location_id_key"
  ON "public"."inventory_count_lines"("session_id", "product_id", "location_id");
