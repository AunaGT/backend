-- CreateTable
CREATE TABLE "supplier_payment_terms" (
    "supplier_id" UUID NOT NULL,
    "payment_term_id" INTEGER NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "supplier_payment_terms_pkey" PRIMARY KEY ("supplier_id","payment_term_id")
);

-- Migrate existing single payment_terms_id into junction table
INSERT INTO "supplier_payment_terms" ("supplier_id", "payment_term_id", "is_default", "sort_order")
SELECT "id", "payment_terms_id", true, 0
FROM "suppliers"
WHERE "payment_terms_id" IS NOT NULL;

-- CreateIndex
CREATE INDEX "supplier_payment_terms_payment_term_id_idx" ON "supplier_payment_terms"("payment_term_id");

-- AddForeignKey
ALTER TABLE "supplier_payment_terms" ADD CONSTRAINT "supplier_payment_terms_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "supplier_payment_terms" ADD CONSTRAINT "supplier_payment_terms_payment_term_id_fkey" FOREIGN KEY ("payment_term_id") REFERENCES "payment_terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DropForeignKey
ALTER TABLE "suppliers" DROP CONSTRAINT IF EXISTS "suppliers_payment_terms_id_fkey";

-- AlterTable
ALTER TABLE "suppliers" DROP COLUMN "payment_terms_id";
