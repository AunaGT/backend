-- Baseline: tablas/columnas que llegaron a prod vía 'prisma db push' sin migración
-- (contabilidad, lotes, refresh tokens, DTE, cambios). En prod NO se ejecuta:
-- se marca como aplicada con: npx prisma migrate resolve --applied 20260811110000_baseline_drift
-- CreateEnum
CREATE TYPE "ReturnType" AS ENUM ('REFUND', 'EXCHANGE');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'COST', 'EXPENSE');

-- CreateEnum
CREATE TYPE "AccountingPeriodStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "JournalSourceType" AS ENUM ('MANUAL', 'SALE', 'RETURN', 'PURCHASE', 'PURCHASE_PAYMENT', 'CLOSING');

-- DropIndex
DROP INDEX "incoming_merchandise_payment_updated_by_idx";

-- AlterTable
ALTER TABLE "cash_register_sessions" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "cash_registers" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "commercial_document_lines" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "commercial_document_sales" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "commercial_documents" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "tracks_expiry" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "returns" ADD COLUMN     "price_difference" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "type" "ReturnType" NOT NULL DEFAULT 'REFUND';

-- AlterTable
ALTER TABLE "stock_reservations" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "system_settings" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "cash_register_id" UUID;

-- CreateTable
CREATE TABLE "product_lots" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_code" VARCHAR(60),
    "expiry_date" DATE,
    "qty_received" INTEGER NOT NULL,
    "qty_remaining" INTEGER NOT NULL,
    "unit_cost" DECIMAL(12,2),
    "supplier_id" UUID,
    "incoming_merchandise_id" UUID,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "replaced_by" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_dtes" (
    "id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "document_type" VARCHAR(50),
    "authorization" VARCHAR(100),
    "series" VARCHAR(20),
    "number" VARCHAR(50),
    "emission_date" TIMESTAMP(3),
    "status" VARCHAR(50),
    "provider" VARCHAR(50),
    "xml_url" VARCHAR(500),
    "pdf_url" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_dtes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_replacement_items" (
    "id" SERIAL NOT NULL,
    "return_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "line_total" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "return_replacement_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "type" "AccountType" NOT NULL,
    "parent_id" INTEGER,
    "is_group" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "system" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_periods" (
    "id" SERIAL NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "AccountingPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "closed_at" TIMESTAMP(3),
    "closed_by" UUID,

    CONSTRAINT "accounting_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL,
    "entry_number" VARCHAR(20) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "source_type" "JournalSourceType" NOT NULL DEFAULT 'MANUAL',
    "source_id" VARCHAR(64),
    "reversal_of_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" SERIAL NOT NULL,
    "entry_id" UUID NOT NULL,
    "account_id" INTEGER NOT NULL,
    "debit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "description" VARCHAR(255),

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_lots_product_id_expiry_date_idx" ON "product_lots"("product_id", "expiry_date");

-- CreateIndex
CREATE INDEX "product_lots_expiry_date_idx" ON "product_lots"("expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "sale_dtes_sale_id_idx" ON "sale_dtes"("sale_id");

-- CreateIndex
CREATE INDEX "return_replacement_items_return_id_idx" ON "return_replacement_items"("return_id");

-- CreateIndex
CREATE INDEX "return_replacement_items_product_id_idx" ON "return_replacement_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_code_key" ON "accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_periods_year_month_key" ON "accounting_periods"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_entry_number_key" ON "journal_entries"("entry_number");

-- CreateIndex
CREATE INDEX "journal_entries_date_idx" ON "journal_entries"("date");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_source_type_source_id_key" ON "journal_entries"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "journal_lines_entry_id_idx" ON "journal_lines"("entry_id");

-- CreateIndex
CREATE INDEX "journal_lines_account_id_idx" ON "journal_lines"("account_id");

-- CreateIndex

-- RenameForeignKey
ALTER TABLE "incoming_merchandise_payment_entries" RENAME CONSTRAINT "incoming_merchandise_payment_entries_incoming_merchandise_id_fk" TO "incoming_merchandise_payment_entries_incoming_merchandise__fkey";

-- AddForeignKey
ALTER TABLE "product_lots" ADD CONSTRAINT "product_lots_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_cash_register_id_fkey" FOREIGN KEY ("cash_register_id") REFERENCES "cash_registers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_dtes" ADD CONSTRAINT "sale_dtes_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_replacement_items" ADD CONSTRAINT "return_replacement_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_replacement_items" ADD CONSTRAINT "return_replacement_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "incoming_merchandise_payment_entries_incoming_merchandise_id_id" RENAME TO "incoming_merchandise_payment_entries_incoming_merchandise_i_idx";

