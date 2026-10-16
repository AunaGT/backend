-- Promociones por sucursal. Aditivo: las promociones existentes quedan como
-- "aplica en todas las sucursales", que es lo que hacían hasta ahora.
ALTER TABLE "promotions"
  ADD COLUMN "applies_to_all_branches" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "promotion_branches" (
  "promotion_id" UUID NOT NULL,
  "branch_id"    UUID NOT NULL,

  CONSTRAINT "promotion_branches_pkey" PRIMARY KEY ("promotion_id", "branch_id")
);

CREATE INDEX "promotion_branches_branch_id_idx" ON "promotion_branches" ("branch_id");

ALTER TABLE "promotion_branches"
  ADD CONSTRAINT "promotion_branches_promotion_id_fkey"
  FOREIGN KEY ("promotion_id") REFERENCES "promotions" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "promotion_branches"
  ADD CONSTRAINT "promotion_branches_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branches" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
