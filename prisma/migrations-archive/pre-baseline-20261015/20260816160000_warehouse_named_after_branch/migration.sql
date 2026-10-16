-- El almacén que se crea solo con cada sucursal se llamaba "Principal" en todas:
-- tres filas distintas con el mismo nombre no se distinguen en ninguna pantalla.
-- Solo renombra los que nadie tocó a mano (siguen con el nombre de fábrica).
UPDATE "public"."warehouses" w
SET "name" = 'Bodega ' || b."name"
FROM "public"."branches" b
WHERE b."id" = w."branch_id"
  AND w."code" = 'PRIN'
  AND w."name" = 'Principal';
