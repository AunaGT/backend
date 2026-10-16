-- Kits/combos: producto tipo KIT con componentes del inventario (BOM)
CREATE TYPE "ProductKind" AS ENUM ('STANDARD', 'KIT');

ALTER TABLE "products" ADD COLUMN "kind" "ProductKind" NOT NULL DEFAULT 'STANDARD';

CREATE TABLE "product_bom_lines" (
    "id" UUID NOT NULL,
    "kit_product_id" UUID NOT NULL,
    "component_product_id" UUID NOT NULL,
    "qty_per_unit" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_bom_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_bom_lines_kit_product_id_component_product_id_key" ON "product_bom_lines"("kit_product_id", "component_product_id");
CREATE INDEX "idx_product_bom_lines_kit" ON "product_bom_lines"("kit_product_id");
CREATE INDEX "idx_product_bom_lines_component" ON "product_bom_lines"("component_product_id");

ALTER TABLE "product_bom_lines" ADD CONSTRAINT "product_bom_lines_kit_product_id_fkey" FOREIGN KEY ("kit_product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_bom_lines" ADD CONSTRAINT "product_bom_lines_component_product_id_fkey" FOREIGN KEY ("component_product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
