-- Abonos parciales en ingresos de mercancía + estado PARTIAL
ALTER TYPE "MerchandisePaymentStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';

CREATE TABLE "incoming_merchandise_payment_entries" (
    "id" UUID NOT NULL,
    "incoming_merchandise_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference" VARCHAR(255),
    "registered_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incoming_merchandise_payment_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "incoming_merchandise_payment_entries_incoming_merchandise_id_idx" ON "incoming_merchandise_payment_entries"("incoming_merchandise_id");

ALTER TABLE "incoming_merchandise_payment_entries" ADD CONSTRAINT "incoming_merchandise_payment_entries_incoming_merchandise_id_fkey" FOREIGN KEY ("incoming_merchandise_id") REFERENCES "incoming_merchandise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "incoming_merchandise_payment_entries" ADD CONSTRAINT "incoming_merchandise_payment_entries_registered_by_fkey" FOREIGN KEY ("registered_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
