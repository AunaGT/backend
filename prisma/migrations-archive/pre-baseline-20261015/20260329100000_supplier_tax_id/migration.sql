-- Identificador fiscal opcional para facturación (NIT, VAT, RFC, etc.)
ALTER TABLE "suppliers" ADD COLUMN "tax_id" VARCHAR(100);
