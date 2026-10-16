-- Precios múltiples (lista/mayoreo/promoción) y reglas por cliente/canal

CREATE TYPE "PriceTier" AS ENUM ('LIST', 'WHOLESALE', 'PROMOTION');
CREATE TYPE "SalesChannel" AS ENUM ('POS', 'WHOLESALE', 'ONLINE');

ALTER TABLE "suppliers" ADD COLUMN "default_price_tier" "PriceTier" NOT NULL DEFAULT 'LIST';

ALTER TABLE "products" ADD COLUMN "price_wholesale" DECIMAL(12,2),
ADD COLUMN "price_promotion" DECIMAL(12,2),
ADD COLUMN "promotion_valid_until" TIMESTAMP(3);

CREATE TABLE "customer_price_rules" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "channel" "SalesChannel",
    "price_tier" "PriceTier" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_price_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_price_rules_supplier_id_active_idx" ON "customer_price_rules"("supplier_id", "active");

ALTER TABLE "customer_price_rules" ADD CONSTRAINT "customer_price_rules_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sales" ADD COLUMN "customer_contact_id" UUID,
ADD COLUMN "sales_channel" "SalesChannel" NOT NULL DEFAULT 'POS';

ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_contact_id_fkey" FOREIGN KEY ("customer_contact_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
