ALTER TABLE "promotions" ADD COLUMN "coupon_design" JSONB;
CREATE TYPE "CouponAssetStatus" AS ENUM ('UPLOADING', 'READY', 'DELETING');
CREATE TABLE "promotion_coupon_assets" (
  "id" UUID NOT NULL PRIMARY KEY,
  "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "created_by" UUID REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "draft_id" UUID NOT NULL,
  "promotion_id" UUID REFERENCES "promotions"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "storage_path" VARCHAR(200) NOT NULL UNIQUE,
  "status" "CouponAssetStatus" NOT NULL DEFAULT 'UPLOADING',
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3)
);
CREATE INDEX "promotion_coupon_assets_company_id_promotion_id_idx" ON "promotion_coupon_assets"("company_id", "promotion_id");
CREATE INDEX "promotion_coupon_assets_status_expires_at_idx" ON "promotion_coupon_assets"("status", "expires_at");
