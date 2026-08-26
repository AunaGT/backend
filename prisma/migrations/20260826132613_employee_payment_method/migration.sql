-- CreateEnum
CREATE TYPE "public"."EmployeePaymentMethod" AS ENUM ('EFECTIVO', 'TRANSFERENCIA', 'CHEQUE');

-- AlterTable
ALTER TABLE "public"."employees"
  ADD COLUMN "payment_method" "public"."EmployeePaymentMethod" NOT NULL DEFAULT 'EFECTIVO',
  ADD COLUMN "bank_name" VARCHAR(100);
