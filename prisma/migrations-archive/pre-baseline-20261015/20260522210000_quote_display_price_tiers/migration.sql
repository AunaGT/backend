-- Tarifas múltiples en cotización (lista / mayoreo / promo) para informes y vistas
ALTER TABLE "commercial_documents"
  ADD COLUMN "quote_display_tiers" JSONB,
  ADD COLUMN "quote_primary_tier" "PriceTier";

ALTER TABLE "commercial_document_lines"
  ADD COLUMN "tier_unit_prices" JSONB;
