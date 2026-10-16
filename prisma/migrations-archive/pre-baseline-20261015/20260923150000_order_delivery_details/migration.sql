ALTER TABLE "commercial_documents"
ADD COLUMN "delivery_carrier" VARCHAR(150),
ADD COLUMN "delivery_tracking_number" VARCHAR(100),
ADD COLUMN "delivery_address" VARCHAR(500),
ADD COLUMN "delivery_dispatched_at" TIMESTAMP(3),
ADD COLUMN "delivery_estimated_at" TIMESTAMP(3);
