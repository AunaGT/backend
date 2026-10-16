-- CreateEnum
CREATE TYPE "public"."SalePaymentStatus" AS ENUM ('PENDING', 'PARTIAL', 'PAID');

-- AlterTable
ALTER TABLE "public"."payment_methods" ADD COLUMN     "is_credit" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "public"."sales" ADD COLUMN     "due_date" TIMESTAMP(3),
ADD COLUMN     "payment_status" "public"."SalePaymentStatus" NOT NULL DEFAULT 'PAID';

-- AlterTable
ALTER TABLE "public"."suppliers" ADD COLUMN     "credit_limit" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "public"."customer_payments" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payment_method_id" INTEGER NOT NULL,
    "cash_register_session_id" UUID,
    "reference" VARCHAR(255),
    "notes" TEXT,
    "registered_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sale_payment_entries" (
    "id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "customer_payment_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_payment_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_payments_customer_id_paid_at_idx" ON "public"."customer_payments"("customer_id", "paid_at" DESC);

-- CreateIndex
CREATE INDEX "customer_payments_branch_id_paid_at_idx" ON "public"."customer_payments"("branch_id", "paid_at" DESC);

-- CreateIndex
CREATE INDEX "customer_payments_cash_register_session_id_idx" ON "public"."customer_payments"("cash_register_session_id");

-- CreateIndex
CREATE INDEX "customer_payments_registered_by_idx" ON "public"."customer_payments"("registered_by");

-- CreateIndex
CREATE INDEX "sale_payment_entries_sale_id_idx" ON "public"."sale_payment_entries"("sale_id");

-- CreateIndex
CREATE INDEX "sale_payment_entries_customer_payment_id_idx" ON "public"."sale_payment_entries"("customer_payment_id");

-- CreateIndex
CREATE INDEX "idx_sales_customer_payment_status_due" ON "public"."sales"("customer_contact_id", "payment_status", "due_date");

-- CreateIndex
CREATE INDEX "idx_sales_payment_status_due" ON "public"."sales"("payment_status", "due_date");

-- AddForeignKey
ALTER TABLE "public"."customer_payments" ADD CONSTRAINT "customer_payments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."customer_payments" ADD CONSTRAINT "customer_payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."customer_payments" ADD CONSTRAINT "customer_payments_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."customer_payments" ADD CONSTRAINT "customer_payments_cash_register_session_id_fkey" FOREIGN KEY ("cash_register_session_id") REFERENCES "public"."cash_register_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."customer_payments" ADD CONSTRAINT "customer_payments_registered_by_fkey" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sale_payment_entries" ADD CONSTRAINT "sale_payment_entries_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sale_payment_entries" ADD CONSTRAINT "sale_payment_entries_customer_payment_id_fkey" FOREIGN KEY ("customer_payment_id") REFERENCES "public"."customer_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
