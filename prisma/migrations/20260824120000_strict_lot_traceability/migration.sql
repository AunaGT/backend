ALTER TABLE "public"."product_lots"
  ADD COLUMN IF NOT EXISTS "is_system_generated" BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."product_lots"
    WHERE location_id IS NULL AND qty_remaining > 0
  ) THEN
    RAISE EXCEPTION 'Cannot enable strict lot traceability: positive lots without a location. Assign each legacy supplier lot to its physical stock location, then retry.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT product_id, branch_id, location_id, SUM(qty_remaining) AS traced
      FROM "public"."product_lots"
      WHERE location_id IS NOT NULL
      GROUP BY product_id, branch_id, location_id
    ) traced
    LEFT JOIN (
      SELECT psl.product_id, w.branch_id, psl.location_id, psl.stock AS physical
      FROM "public"."product_stock_locations" psl
      JOIN "public"."stock_locations" l ON l.id = psl.location_id
      JOIN "public"."warehouses" w ON w.id = l.warehouse_id
    ) physical
      ON physical.product_id = traced.product_id
      AND physical.branch_id = traced.branch_id
      AND physical.location_id = traced.location_id
    WHERE traced.traced > COALESCE(physical.physical, 0)
  ) THEN
    RAISE EXCEPTION 'Cannot enable strict lot traceability: traced stock exceeds physical stock';
  END IF;

  INSERT INTO "public"."product_lots" (
    id, product_id, branch_id, location_id, lot_code, qty_received, qty_remaining,
    is_system_generated, received_at
  )
  SELECT
    gen_random_uuid(), physical.product_id, physical.branch_id, physical.location_id,
    'LEGACY-' || left(physical.location_id::text, 8),
    physical.physical - COALESCE(traced.traced, 0),
    physical.physical - COALESCE(traced.traced, 0),
    true, now()
  FROM (
    SELECT psl.product_id, w.branch_id, psl.location_id, psl.stock AS physical
    FROM "public"."product_stock_locations" psl
    JOIN "public"."stock_locations" l ON l.id = psl.location_id
    JOIN "public"."warehouses" w ON w.id = l.warehouse_id
  ) physical
  LEFT JOIN (
    SELECT product_id, branch_id, location_id, SUM(qty_remaining) AS traced
    FROM "public"."product_lots"
    WHERE location_id IS NOT NULL
    GROUP BY product_id, branch_id, location_id
  ) traced
    ON traced.product_id = physical.product_id
    AND traced.branch_id = physical.branch_id
    AND traced.location_id = physical.location_id
  WHERE physical.physical > COALESCE(traced.traced, 0);

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT product_id, branch_id, location_id, SUM(qty_remaining) AS traced
      FROM "public"."product_lots"
      WHERE location_id IS NOT NULL
      GROUP BY product_id, branch_id, location_id
    ) traced
    FULL JOIN (
      SELECT psl.product_id, w.branch_id, psl.location_id, psl.stock AS physical
      FROM "public"."product_stock_locations" psl
      JOIN "public"."stock_locations" l ON l.id = psl.location_id
      JOIN "public"."warehouses" w ON w.id = l.warehouse_id
    ) physical
      ON physical.product_id = traced.product_id
      AND physical.branch_id = traced.branch_id
      AND physical.location_id = traced.location_id
    WHERE COALESCE(traced.traced, 0) IS DISTINCT FROM COALESCE(physical.physical, 0)
  ) THEN
    RAISE EXCEPTION 'Cannot enable strict lot traceability: location invariant remains inconsistent';
  END IF;
END $$;
