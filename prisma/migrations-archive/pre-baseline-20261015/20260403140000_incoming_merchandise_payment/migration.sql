-- CreateEnum
CREATE TYPE "MerchandisePaymentStatus" AS ENUM ('PENDING', 'PAID');

-- AlterTable
ALTER TABLE "incoming_merchandise" ADD COLUMN "payment_term_id" INTEGER,
ADD COLUMN "payment_status" "MerchandisePaymentStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "paid_at" TIMESTAMP(3),
ADD COLUMN "payment_reference" VARCHAR(255),
ADD COLUMN "due_date" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "incoming_merchandise" ADD CONSTRAINT "incoming_merchandise_payment_term_id_fkey" FOREIGN KEY ("payment_term_id") REFERENCES "payment_terms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "incoming_merchandise_payment_status_idx" ON "incoming_merchandise"("payment_status");
