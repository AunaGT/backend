-- AlterTable
ALTER TABLE "payment_terms" ADD COLUMN "net_days" INTEGER;

-- AlterTable
ALTER TABLE "incoming_merchandise" ADD COLUMN "payment_updated_by" UUID,
ADD COLUMN "payment_updated_at" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "incoming_merchandise" ADD CONSTRAINT "incoming_merchandise_payment_updated_by_fkey" FOREIGN KEY ("payment_updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "incoming_merchandise_payment_updated_by_idx" ON "incoming_merchandise"("payment_updated_by");
