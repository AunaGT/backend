-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalSourceType" ADD VALUE 'CUSTOMER_ADVANCE';
ALTER TYPE "JournalSourceType" ADD VALUE 'CUSTOMER_ADVANCE_APPLIED';
ALTER TYPE "JournalSourceType" ADD VALUE 'CUSTOMER_PAYMENT_REFUND';

-- AlterTable
ALTER TABLE "service_schedule_profiles" ADD COLUMN     "public_instructions" VARCHAR(2000) NOT NULL DEFAULT '';
ALTER TABLE "service_schedule_profiles" ADD COLUMN "completion_policy" VARCHAR(10) NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "service_schedule_profiles" ADD CONSTRAINT "service_completion_policy_check" CHECK ("completion_policy" = 'MANUAL' OR ("completion_policy" = 'AUTO' AND "scheduling_style" = 'WORK'));
ALTER TABLE "appointment_history" ALTER COLUMN "actor_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "appointment_sessions" ADD COLUMN     "actual_completed_at" TIMESTAMP(3),
ADD COLUMN     "commercial_completion_confirmed_at" TIMESTAMP(3),
ADD COLUMN     "completion_policy" VARCHAR(10) NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "settlement_source" VARCHAR(30) NOT NULL DEFAULT 'LEGACY';

-- AlterTable
ALTER TABLE "commercial_document_lines" ADD COLUMN     "service_schedule_snapshot" JSONB;

-- CreateTable
CREATE TABLE "appointment_engagements" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "source" VARCHAR(10) NOT NULL,
    "quote_id" UUID,
    "order_id" UUID,
    "sale_id" UUID,
    "currency_code" VARCHAR(3) NOT NULL,
    "agreed_total" DECIMAL(12,2) NOT NULL,
    "commercial_snapshot" JSONB NOT NULL,
    "resolution_pending" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointment_engagements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_engagement_lines" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "engagement_id" UUID NOT NULL,
    "source_document_id" UUID,
    "source_line_id" UUID,
    "product_id" UUID NOT NULL,
    "item_kind" "ProductKind" NOT NULL,
    "item_name" VARCHAR(150) NOT NULL,
    "unit_label" VARCHAR(50) NOT NULL,
    "quantity_decimals" INTEGER NOT NULL DEFAULT 0,
    "qty" DECIMAL(12,4) NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "line_total" DECIMAL(12,2) NOT NULL,
    "service_schedule_snapshot" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "appointment_engagement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_engagement_schedules" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "engagement_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "session_type" VARCHAR(20) NOT NULL,
    "booking_id" UUID,
    "kind" VARCHAR(10) NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,
    "state" VARCHAR(15) NOT NULL DEFAULT 'COMMITTED',
    "conditions_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_engagement_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_commitments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "engagement_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "state" VARCHAR(15) NOT NULL DEFAULT 'COMMITTED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_commitments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocation_events" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "engagement_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "commitment_id" UUID,
    "action" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "request_key" VARCHAR(64) NOT NULL,
    "input_hash" VARCHAR(64) NOT NULL,
    "actor_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_payment_refunds" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "engagement_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" VARCHAR(15) NOT NULL DEFAULT 'REQUESTED',
    "payment_method_id" INTEGER,
    "cash_register_session_id" UUID,
    "reference" VARCHAR(255) NOT NULL DEFAULT '',
    "reason" VARCHAR(500) NOT NULL,
    "request_key" VARCHAR(64) NOT NULL,
    "confirmed_key" VARCHAR(64),
    "input_hash" VARCHAR(64) NOT NULL,
    "registered_by" UUID NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_payment_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_engagement_history" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "engagement_id" UUID NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(30) NOT NULL,
    "reason" VARCHAR(500) NOT NULL DEFAULT '',
    "before" JSONB,
    "after" JSONB,
    "request_key" VARCHAR(64) NOT NULL,
    "input_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_engagement_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "appointment_engagements_quote_id_key" ON "appointment_engagements"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_engagements_order_id_key" ON "appointment_engagements"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_engagements_sale_id_key" ON "appointment_engagements"("sale_id");

-- CreateIndex
CREATE INDEX "appointment_engagements_company_id_branch_id_created_at_idx" ON "appointment_engagements"("company_id", "branch_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_branch_identity_key" ON "appointment_engagements"("company_id", "branch_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_quote_branch_key" ON "appointment_engagements"("branch_id", "quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_order_branch_key" ON "appointment_engagements"("branch_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_sale_branch_key" ON "appointment_engagements"("branch_id", "sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_customer_identity_key" ON "appointment_engagements"("company_id", "branch_id", "customer_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_quote_identity_key" ON "appointment_engagements"("company_id", "branch_id", "id", "quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_line_identity_key" ON "appointment_engagement_lines"("company_id", "branch_id", "engagement_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_engagement_lines_engagement_id_source_line_id_key" ON "appointment_engagement_lines"("engagement_id", "source_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_engagement_schedules_booking_id_key" ON "appointment_engagement_schedules"("booking_id");

-- CreateIndex
CREATE INDEX "appointment_engagement_schedules_company_id_engagement_id_s_idx" ON "appointment_engagement_schedules"("company_id", "engagement_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_engagement_schedules_line_id_session_id_key" ON "appointment_engagement_schedules"("line_id", "session_id");

-- CreateIndex
CREATE INDEX "payment_commitments_payment_id_state_idx" ON "payment_commitments"("payment_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "payment_commitments_engagement_id_payment_id_key" ON "payment_commitments"("engagement_id", "payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "commitment_identity_key" ON "payment_commitments"("company_id", "branch_id", "customer_id", "engagement_id", "payment_id", "id");

-- CreateIndex
CREATE INDEX "payment_allocation_events_payment_id_created_at_idx" ON "payment_allocation_events"("payment_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "allocation_attempt_key" ON "payment_allocation_events"("company_id", "payment_id", "request_key", "action");

-- CreateIndex
CREATE UNIQUE INDEX "customer_payment_refunds_confirmed_key_key" ON "customer_payment_refunds"("confirmed_key");

-- CreateIndex
CREATE INDEX "customer_payment_refunds_payment_id_status_idx" ON "customer_payment_refunds"("payment_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "customer_payment_refunds_company_id_request_key_key" ON "customer_payment_refunds"("company_id", "request_key");

-- CreateIndex
CREATE INDEX "appointment_engagement_history_company_id_engagement_id_cre_idx" ON "appointment_engagement_history"("company_id", "engagement_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_history_attempt_key" ON "appointment_engagement_history"("engagement_id", "request_key", "action");

-- CreateIndex
CREATE UNIQUE INDEX "booking_session_identity_key" ON "appointment_bookings"("company_id", "session_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_branch_identity_key" ON "sales"("branch_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_branch_identity_key" ON "commercial_documents"("branch_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_line_identity_key" ON "commercial_document_lines"("document_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_customer_identity_key" ON "customer_payments"("branch_id", "customer_id", "id");

-- AddForeignKey
ALTER TABLE "appointment_engagements" ADD CONSTRAINT "appointment_engagements_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branches"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_engagements" ADD CONSTRAINT "appointment_engagements_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "suppliers"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_engagements" ADD CONSTRAINT "appointment_engagements_branch_id_quote_id_fkey" FOREIGN KEY ("branch_id", "quote_id") REFERENCES "commercial_documents"("branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_engagements" ADD CONSTRAINT "appointment_engagements_branch_id_order_id_fkey" FOREIGN KEY ("branch_id", "order_id") REFERENCES "commercial_documents"("branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_engagements" ADD CONSTRAINT "appointment_engagements_branch_id_sale_id_fkey" FOREIGN KEY ("branch_id", "sale_id") REFERENCES "sales"("branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_engagements" ADD CONSTRAINT "appointment_engagements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_engagement_lines" ADD CONSTRAINT "appointment_engagement_lines_company_id_branch_id_engageme_fkey" FOREIGN KEY ("company_id", "branch_id", "engagement_id") REFERENCES "appointment_engagements"("company_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_engagement_lines" ADD CONSTRAINT "appointment_engagement_lines_source_document_id_source_lin_fkey" FOREIGN KEY ("source_document_id", "source_line_id") REFERENCES "commercial_document_lines"("document_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_engagement_lines" ADD CONSTRAINT "engagement_line_quote_fkey" FOREIGN KEY ("company_id", "branch_id", "engagement_id", "source_document_id") REFERENCES "appointment_engagements"("company_id", "branch_id", "id", "quote_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_engagement_lines" ADD CONSTRAINT "appointment_engagement_lines_company_id_product_id_fkey" FOREIGN KEY ("company_id", "product_id") REFERENCES "products"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_engagement_schedules" ADD CONSTRAINT "appointment_engagement_schedules_company_id_branch_id_enga_fkey" FOREIGN KEY ("company_id", "branch_id", "engagement_id", "line_id") REFERENCES "appointment_engagement_lines"("company_id", "branch_id", "engagement_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_engagement_schedules" ADD CONSTRAINT "appointment_engagement_schedules_company_id_branch_id_sess_fkey" FOREIGN KEY ("company_id", "branch_id", "session_id", "session_type") REFERENCES "appointment_sessions"("company_id", "branch_id", "id", "record_type") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_engagement_schedules" ADD CONSTRAINT "appointment_engagement_schedules_company_id_session_id_boo_fkey" FOREIGN KEY ("company_id", "session_id", "booking_id") REFERENCES "appointment_bookings"("company_id", "session_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_commitments" ADD CONSTRAINT "payment_commitments_company_id_branch_id_customer_id_engag_fkey" FOREIGN KEY ("company_id", "branch_id", "customer_id", "engagement_id") REFERENCES "appointment_engagements"("company_id", "branch_id", "customer_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_commitments" ADD CONSTRAINT "payment_commitments_branch_id_customer_id_payment_id_fkey" FOREIGN KEY ("branch_id", "customer_id", "payment_id") REFERENCES "customer_payments"("branch_id", "customer_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation_events" ADD CONSTRAINT "payment_allocation_events_company_id_branch_id_customer_id_fkey" FOREIGN KEY ("company_id", "branch_id", "customer_id", "engagement_id") REFERENCES "appointment_engagements"("company_id", "branch_id", "customer_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation_events" ADD CONSTRAINT "payment_allocation_events_branch_id_customer_id_payment_id_fkey" FOREIGN KEY ("branch_id", "customer_id", "payment_id") REFERENCES "customer_payments"("branch_id", "customer_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation_events" ADD CONSTRAINT "allocation_commitment_fkey" FOREIGN KEY ("company_id", "branch_id", "customer_id", "engagement_id", "payment_id", "commitment_id") REFERENCES "payment_commitments"("company_id", "branch_id", "customer_id", "engagement_id", "payment_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation_events" ADD CONSTRAINT "payment_allocation_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_payment_refunds" ADD CONSTRAINT "customer_payment_refunds_company_id_branch_id_customer_id__fkey" FOREIGN KEY ("company_id", "branch_id", "customer_id", "engagement_id") REFERENCES "appointment_engagements"("company_id", "branch_id", "customer_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_payment_refunds" ADD CONSTRAINT "customer_payment_refunds_branch_id_customer_id_payment_id_fkey" FOREIGN KEY ("branch_id", "customer_id", "payment_id") REFERENCES "customer_payments"("branch_id", "customer_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_payment_refunds" ADD CONSTRAINT "customer_payment_refunds_cash_register_session_id_fkey" FOREIGN KEY ("cash_register_session_id") REFERENCES "cash_register_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_payment_refunds" ADD CONSTRAINT "customer_payment_refunds_registered_by_fkey" FOREIGN KEY ("registered_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_engagement_history" ADD CONSTRAINT "appointment_engagement_history_company_id_branch_id_custom_fkey" FOREIGN KEY ("company_id", "branch_id", "customer_id", "engagement_id") REFERENCES "appointment_engagements"("company_id", "branch_id", "customer_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_engagement_history" ADD CONSTRAINT "appointment_engagement_history_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- No historical money, links or private instructions are backfilled.
ALTER TABLE "appointment_engagements" ADD CONSTRAINT "engagement_rules_check" CHECK (
  "source" IN ('DIRECT','QUOTE') AND (("source" = 'QUOTE') = ("quote_id" IS NOT NULL))
  AND "currency_code" ~ '^[A-Z]{3}$' AND "agreed_total" >= 0 AND "version" > 0
);
ALTER TABLE "appointment_engagement_lines" ADD CONSTRAINT "engagement_line_rules_check" CHECK (
  "qty" > 0 AND "quantity_decimals" BETWEEN 0 AND 4
  AND "qty" = round("qty", "quantity_decimals") AND "unit_price" >= 0 AND "line_total" >= 0
  AND (("source_document_id" IS NULL) = ("source_line_id" IS NULL))
);
ALTER TABLE "appointment_engagement_schedules" ADD CONSTRAINT "engagement_schedule_rules_check" CHECK (
  "quantity" > 0 AND "state" IN ('COMMITTED','COMPLETED','SOLD','CANCELLED','RELEASED')
  AND (("kind" = 'BOOKING' AND "booking_id" IS NOT NULL AND "session_type" = 'SCHEDULED_SERVICE')
    OR ("kind" = 'SESSION' AND "booking_id" IS NULL AND "session_type" = 'SCHEDULED_SERVICE')
    OR ("kind" = 'ACTIVITY' AND "booking_id" IS NULL AND "session_type" = 'ACTIVITY'))
);
CREATE UNIQUE INDEX "engagement_exclusive_session_key" ON "appointment_engagement_schedules" ("session_id") WHERE "kind" IN ('SESSION','ACTIVITY');
ALTER TABLE "payment_commitments" ADD CONSTRAINT "commitment_rules_check" CHECK (
  "amount" > 0 AND "version" > 0 AND "state" IN ('COMMITTED','APPLIED','RELEASED','REFUNDED')
);
ALTER TABLE "payment_allocation_events" ADD CONSTRAINT "allocation_rules_check" CHECK (
  "amount" > 0 AND "action" IN ('COMMITTED','APPLIED','RELEASED','REFUND_REQUESTED','REFUNDED','REFUND_CANCELLED','SALE_REFUNDED','SALE_RELEASED')
);
ALTER TABLE "customer_payment_refunds" ADD CONSTRAINT "refund_rules_check" CHECK (
  "amount" > 0 AND "status" IN ('REQUESTED','CONFIRMED','CANCELLED')
  AND (("status" = 'CONFIRMED') = ("confirmed_at" IS NOT NULL AND "confirmed_key" IS NOT NULL))
);
ALTER TABLE "sales" ADD CONSTRAINT "sale_settlement_source_check" CHECK ("settlement_source" IN ('LEGACY','ENGAGEMENT_RECEIPTS'));
ALTER TABLE "payment_allocation_events" ADD COLUMN "return_settlement_id" UUID;
ALTER TABLE "payment_allocation_events" ADD CONSTRAINT "payment_allocation_events_return_settlement_id_fkey" FOREIGN KEY ("return_settlement_id") REFERENCES "return_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_allocation_events" ADD CONSTRAINT "allocation_sale_return_source_check" CHECK (("action" IN ('SALE_REFUNDED','SALE_RELEASED')) = ("return_settlement_id" IS NOT NULL));
ALTER TABLE "appointment_sessions" ADD CONSTRAINT "appointment_completion_policy_check" CHECK ("completion_policy" IN ('MANUAL','AUTO'));
ALTER TABLE "appointment_requests" DROP CONSTRAINT "appointment_request_result_check";
ALTER TABLE "appointment_requests" ADD CONSTRAINT "appointment_request_result_check" CHECK ("result_type" IN ('BOOKING','SESSION','WAITLIST','ACTIVITY','ENGAGEMENT','PAYMENT') AND "input_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "customer_payment_refunds" ADD CONSTRAINT "customer_payment_refunds_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
