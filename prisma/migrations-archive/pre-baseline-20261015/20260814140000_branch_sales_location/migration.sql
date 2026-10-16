-- Ubicación desde la que despacha el punto de venta de la sucursal.
ALTER TABLE "public"."branches" ADD COLUMN "sales_location_id" UUID;

ALTER TABLE "public"."branches"
  ADD CONSTRAINT "branches_sales_location_id_fkey"
  FOREIGN KEY ("sales_location_id") REFERENCES "public"."stock_locations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
