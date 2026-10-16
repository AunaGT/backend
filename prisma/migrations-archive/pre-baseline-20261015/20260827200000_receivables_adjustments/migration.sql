-- CreateEnum
CREATE TYPE "public"."CustomerPaymentKind" AS ENUM ('PAYMENT', 'CREDIT_NOTE', 'WRITE_OFF');

-- DropForeignKey
ALTER TABLE "public"."customer_payments" DROP CONSTRAINT "customer_payments_payment_method_id_fkey";

-- AlterTable
ALTER TABLE "public"."customer_payments" ADD COLUMN     "kind" "public"."CustomerPaymentKind" NOT NULL DEFAULT 'PAYMENT',
ALTER COLUMN "payment_method_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "public"."customer_payments" ADD CONSTRAINT "customer_payments_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

