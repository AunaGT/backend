-- Multi-empresa + sucursales.
-- Seguro sobre datos existentes: crea la empresa/sucursal "Principal", agrega
-- las columnas como NULL, hace backfill y recién entonces las vuelve NOT NULL.

-- ========== 1. Enum y tablas nuevas ==========

CREATE TYPE "StockTransferStatus" AS ENUM ('EN_TRANSITO', 'RECIBIDA', 'CANCELADA');

CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "tax_id" VARCHAR(100),
    "address" TEXT,
    "phone" VARCHAR(50),
    "logo_url" VARCHAR(500),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_companies" (
    "user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_companies_pkey" PRIMARY KEY ("user_id","company_id")
);

CREATE TABLE "branches" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "seq" SERIAL NOT NULL,
    "address" TEXT,
    "phone" VARCHAR(50),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_branches" (
    "user_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_branches_pkey" PRIMARY KEY ("user_id","branch_id")
);

CREATE TABLE "product_stocks" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "min_stock" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "product_stocks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_transfers" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(30) NOT NULL,
    "from_branch_id" UUID NOT NULL,
    "to_branch_id" UUID NOT NULL,
    "status" "StockTransferStatus" NOT NULL DEFAULT 'EN_TRANSITO',
    "created_by" UUID NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_by" UUID,
    "received_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "notes" TEXT,
    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_transfer_lines" (
    "id" UUID NOT NULL,
    "transfer_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "qty_sent" INTEGER NOT NULL,
    "qty_received" INTEGER,
    CONSTRAINT "stock_transfer_lines_pkey" PRIMARY KEY ("id")
);

-- ========== 2. Seed: empresa y sucursal "Principal" ==========

INSERT INTO "companies" ("id", "name", "code", "is_default", "updated_at")
VALUES ('00000000-0000-4000-8000-000000000001', 'Principal', 'PRIN', true, CURRENT_TIMESTAMP);

INSERT INTO "branches" ("id", "company_id", "name", "code", "is_default", "updated_at")
VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Principal', 'PRIN', true, CURRENT_TIMESTAMP);

-- Todos los usuarios existentes pertenecen a la empresa y sucursal Principal
INSERT INTO "user_companies" ("user_id", "company_id")
SELECT "id", '00000000-0000-4000-8000-000000000001' FROM "users";

INSERT INTO "user_branches" ("user_id", "branch_id")
SELECT "id", '00000000-0000-4000-8000-000000000002' FROM "users";

-- ========== 3. Columnas nuevas (NULL primero) ==========

ALTER TABLE "product_categories" ADD COLUMN "company_id" UUID;
ALTER TABLE "payment_terms" ADD COLUMN "company_id" UUID;
ALTER TABLE "suppliers" ADD COLUMN "company_id" UUID;
ALTER TABLE "products" ADD COLUMN "company_id" UUID;
ALTER TABLE "promotions" ADD COLUMN "company_id" UUID;
ALTER TABLE "promotion_codes" ADD COLUMN "company_id" UUID;
ALTER TABLE "system_settings" ADD COLUMN "company_id" UUID;
ALTER TABLE "accounts" ADD COLUMN "company_id" UUID;
ALTER TABLE "accounting_periods" ADD COLUMN "company_id" UUID;
ALTER TABLE "journal_entries" ADD COLUMN "company_id" UUID;

ALTER TABLE "product_lots" ADD COLUMN "branch_id" UUID;
ALTER TABLE "alerts" ADD COLUMN "branch_id" UUID;
ALTER TABLE "sales" ADD COLUMN "branch_id" UUID;
ALTER TABLE "commercial_documents" ADD COLUMN "branch_id" UUID;
ALTER TABLE "stock_reservations" ADD COLUMN "branch_id" UUID;
ALTER TABLE "incoming_merchandise" ADD COLUMN "branch_id" UUID;
ALTER TABLE "cash_registers" ADD COLUMN "branch_id" UUID;
ALTER TABLE "cash_closures" ADD COLUMN "branch_id" UUID;
ALTER TABLE "inventory_count_sessions" ADD COLUMN "branch_id" UUID;

ALTER TABLE "users" ADD COLUMN "default_branch_id" UUID;

ALTER TABLE "sales" ALTER COLUMN "reference" SET DATA TYPE VARCHAR(30);
ALTER TABLE "commercial_documents" ALTER COLUMN "reference" SET DATA TYPE VARCHAR(30);

-- ========== 4. Backfill ==========

UPDATE "product_categories" SET "company_id" = '00000000-0000-4000-8000-000000000001';
UPDATE "payment_terms" SET "company_id" = '00000000-0000-4000-8000-000000000001';
UPDATE "suppliers" SET "company_id" = '00000000-0000-4000-8000-000000000001';
UPDATE "products" SET "company_id" = '00000000-0000-4000-8000-000000000001';
UPDATE "promotions" SET "company_id" = '00000000-0000-4000-8000-000000000001';
UPDATE "promotion_codes" SET "company_id" = '00000000-0000-4000-8000-000000000001';
UPDATE "system_settings" SET "company_id" = '00000000-0000-4000-8000-000000000001';
UPDATE "accounts" SET "company_id" = '00000000-0000-4000-8000-000000000001';
UPDATE "accounting_periods" SET "company_id" = '00000000-0000-4000-8000-000000000001';
UPDATE "journal_entries" SET "company_id" = '00000000-0000-4000-8000-000000000001';

UPDATE "product_lots" SET "branch_id" = '00000000-0000-4000-8000-000000000002';
UPDATE "alerts" SET "branch_id" = '00000000-0000-4000-8000-000000000002';
UPDATE "sales" SET "branch_id" = '00000000-0000-4000-8000-000000000002';
UPDATE "commercial_documents" SET "branch_id" = '00000000-0000-4000-8000-000000000002';
UPDATE "stock_reservations" SET "branch_id" = '00000000-0000-4000-8000-000000000002';
UPDATE "incoming_merchandise" SET "branch_id" = '00000000-0000-4000-8000-000000000002';
UPDATE "cash_registers" SET "branch_id" = '00000000-0000-4000-8000-000000000002';
UPDATE "cash_closures" SET "branch_id" = '00000000-0000-4000-8000-000000000002';
UPDATE "inventory_count_sessions" SET "branch_id" = '00000000-0000-4000-8000-000000000002';

UPDATE "users" SET "default_branch_id" = '00000000-0000-4000-8000-000000000002';

-- Stock actual de cada producto pasa a ser el stock de la sucursal Principal.
-- products.stock queda como espejo (suma de sucursales) durante la transición.
INSERT INTO "product_stocks" ("id", "product_id", "branch_id", "stock", "min_stock")
SELECT gen_random_uuid(), "id", '00000000-0000-4000-8000-000000000002', "stock", "min_stock"
FROM "products";

-- ========== 5. NOT NULL ==========

ALTER TABLE "product_categories" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "payment_terms" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "suppliers" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "products" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "promotions" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "promotion_codes" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "system_settings" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "accounts" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "accounting_periods" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "journal_entries" ALTER COLUMN "company_id" SET NOT NULL;

ALTER TABLE "product_lots" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "alerts" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "sales" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "commercial_documents" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "stock_reservations" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "incoming_merchandise" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "cash_registers" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "cash_closures" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "inventory_count_sessions" ALTER COLUMN "branch_id" SET NOT NULL;

-- ========== 6. Índices: únicos globales → por empresa/sucursal ==========

DROP INDEX "product_categories_name_key";
DROP INDEX "payment_terms_name_key";
DROP INDEX "products_barcode_key";
DROP INDEX "sales_reference_key";
DROP INDEX "commercial_documents_reference_key";
DROP INDEX "cash_registers_code_key";
DROP INDEX "promotion_codes_code_key";
DROP INDEX "promotion_codes_code_idx";
DROP INDEX "system_settings_key_key";
DROP INDEX "accounts_code_key";
DROP INDEX "accounting_periods_year_month_key";
DROP INDEX "journal_entries_entry_number_key";
DROP INDEX "journal_entries_source_type_source_id_key";

CREATE UNIQUE INDEX "companies_code_key" ON "companies"("code");
CREATE INDEX "user_companies_company_id_idx" ON "user_companies"("company_id");
CREATE UNIQUE INDEX "branches_seq_key" ON "branches"("seq");
CREATE UNIQUE INDEX "branches_company_id_code_key" ON "branches"("company_id", "code");
CREATE INDEX "user_branches_branch_id_idx" ON "user_branches"("branch_id");
CREATE INDEX "product_stocks_branch_id_idx" ON "product_stocks"("branch_id");
CREATE UNIQUE INDEX "product_stocks_product_id_branch_id_key" ON "product_stocks"("product_id", "branch_id");
CREATE INDEX "stock_transfers_to_branch_id_status_idx" ON "stock_transfers"("to_branch_id", "status");
CREATE INDEX "stock_transfers_from_branch_id_status_idx" ON "stock_transfers"("from_branch_id", "status");
CREATE UNIQUE INDEX "stock_transfers_from_branch_id_reference_key" ON "stock_transfers"("from_branch_id", "reference");
CREATE INDEX "stock_transfer_lines_transfer_id_idx" ON "stock_transfer_lines"("transfer_id");
CREATE INDEX "stock_transfer_lines_product_id_idx" ON "stock_transfer_lines"("product_id");

CREATE UNIQUE INDEX "product_categories_company_id_name_key" ON "product_categories"("company_id", "name");
CREATE UNIQUE INDEX "payment_terms_company_id_name_key" ON "payment_terms"("company_id", "name");
CREATE INDEX "suppliers_company_id_party_type_idx" ON "suppliers"("company_id", "party_type");
CREATE INDEX "products_company_id_idx" ON "products"("company_id");
CREATE UNIQUE INDEX "products_company_id_barcode_key" ON "products"("company_id", "barcode");
CREATE INDEX "product_lots_branch_id_idx" ON "product_lots"("branch_id");
CREATE INDEX "alerts_branch_id_idx" ON "alerts"("branch_id");
CREATE INDEX "sales_branch_id_date_idx" ON "sales"("branch_id", "date" DESC);
CREATE UNIQUE INDEX "sales_branch_id_reference_key" ON "sales"("branch_id", "reference");
CREATE UNIQUE INDEX "commercial_documents_branch_id_reference_key" ON "commercial_documents"("branch_id", "reference");
CREATE INDEX "stock_reservations_branch_id_product_id_status_idx" ON "stock_reservations"("branch_id", "product_id", "status");
CREATE INDEX "incoming_merchandise_branch_id_date_idx" ON "incoming_merchandise"("branch_id", "date" DESC);
CREATE UNIQUE INDEX "cash_registers_branch_id_code_key" ON "cash_registers"("branch_id", "code");
CREATE INDEX "cash_closures_branch_id_date_idx" ON "cash_closures"("branch_id", "date" DESC);
CREATE INDEX "promotions_company_id_idx" ON "promotions"("company_id");
CREATE UNIQUE INDEX "promotion_codes_company_id_code_key" ON "promotion_codes"("company_id", "code");
CREATE INDEX "inventory_count_sessions_branch_id_idx" ON "inventory_count_sessions"("branch_id");
CREATE UNIQUE INDEX "system_settings_company_id_key_key" ON "system_settings"("company_id", "key");
CREATE UNIQUE INDEX "accounts_company_id_code_key" ON "accounts"("company_id", "code");
CREATE UNIQUE INDEX "accounting_periods_company_id_year_month_key" ON "accounting_periods"("company_id", "year", "month");
CREATE UNIQUE INDEX "journal_entries_company_id_source_type_source_id_key" ON "journal_entries"("company_id", "source_type", "source_id");
CREATE UNIQUE INDEX "journal_entries_company_id_entry_number_key" ON "journal_entries"("company_id", "entry_number");

-- ========== 7. Foreign keys ==========

ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branches" ADD CONSTRAINT "branches_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_branches" ADD CONSTRAINT "user_branches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_branches" ADD CONSTRAINT "user_branches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_stocks" ADD CONSTRAINT "product_stocks_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_stocks" ADD CONSTRAINT "product_stocks_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_branch_id_fkey" FOREIGN KEY ("from_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_branch_id_fkey" FOREIGN KEY ("to_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_terms" ADD CONSTRAINT "payment_terms_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_lots" ADD CONSTRAINT "product_lots_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_default_branch_id_fkey" FOREIGN KEY ("default_branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales" ADD CONSTRAINT "sales_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commercial_documents" ADD CONSTRAINT "commercial_documents_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "incoming_merchandise" ADD CONSTRAINT "incoming_merchandise_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_closures" ADD CONSTRAINT "cash_closures_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "promotion_codes" ADD CONSTRAINT "promotion_codes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_count_sessions" ADD CONSTRAINT "inventory_count_sessions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
