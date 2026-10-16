-- Los lotes viven en una ubicación: el mismo lote repartido en dos anaqueles son
-- dos filas. Queda nullable a propósito: un lote sin ubicación conocida sigue
-- sirviendo para caducidad (es capa advisory) y despacha desde cualquier anaquel.
ALTER TABLE "public"."product_lots" ADD COLUMN "location_id" UUID;

-- Backfill: lo que ya había estaba, de hecho, en la ubicación por defecto de su
-- sucursal (es donde el motor venía guardando todo).
UPDATE "public"."product_lots" pl
SET "location_id" = d.location_id
FROM (
  SELECT DISTINCT ON (w.branch_id) w.branch_id, l.id AS location_id
  FROM "public"."stock_locations" l
  JOIN "public"."warehouses" w ON w.id = l.warehouse_id
  WHERE w.active AND l.active
  ORDER BY w.branch_id, w.is_receiving DESC, w.is_default DESC, l.is_default DESC,
           w.dispatch_priority, l.dispatch_priority, l.code
) d
WHERE pl."location_id" IS NULL AND d.branch_id = pl."branch_id";

ALTER TABLE "public"."product_lots"
  ADD CONSTRAINT "product_lots_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "product_lots_product_id_location_id_expiry_date_idx"
  ON "public"."product_lots"("product_id", "location_id", "expiry_date");
