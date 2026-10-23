ALTER TYPE "StockMovementReason" ADD VALUE IF NOT EXISTS 'PRODUCTION';
ALTER TYPE "MerchandiseSource" ADD VALUE IF NOT EXISTS 'PRODUCTION';
ALTER TABLE "purchase_logs" ALTER COLUMN "supplier_id" DROP NOT NULL;
ALTER TABLE "incoming_merchandise" ALTER COLUMN "supplier_id" DROP NOT NULL;
ALTER TABLE "incoming_merchandise" ADD COLUMN "production_details" JSONB;
