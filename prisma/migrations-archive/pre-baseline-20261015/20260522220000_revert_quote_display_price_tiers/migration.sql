-- Revert tarifas múltiples en cotización
ALTER TABLE "commercial_document_lines" DROP COLUMN IF EXISTS "tier_unit_prices";

ALTER TABLE "commercial_documents"
  DROP COLUMN IF EXISTS "quote_primary_tier",
  DROP COLUMN IF EXISTS "quote_display_tiers";
