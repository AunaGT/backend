ALTER TABLE "commercial_documents"
  ADD COLUMN "payment_condition" VARCHAR(10) NOT NULL DEFAULT 'CASH',
  ADD COLUMN "credit_days" INTEGER;
ALTER TABLE "commercial_documents" ADD CONSTRAINT "commercial_payment_terms_valid"
  CHECK ((payment_condition = 'CASH' AND credit_days IS NULL)
    OR (payment_condition = 'CREDIT' AND credit_days IS NOT NULL AND credit_days BETWEEN 0 AND 3650));
