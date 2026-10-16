CREATE TABLE "payroll_rate_versions" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "effective_from" DATE,
  "is_baseline" BOOLEAN NOT NULL DEFAULT false,
  "rates" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "created_by" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelled_at" TIMESTAMP(3),
  "cancelled_by" UUID,
  "cancel_reason" TEXT,
  CONSTRAINT "payroll_rate_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payroll_rate_versions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "payroll_rates_baseline_date" CHECK ((is_baseline AND effective_from IS NULL) OR (NOT is_baseline AND effective_from IS NOT NULL))
);
CREATE INDEX "payroll_rate_versions_company_id_effective_from_idx" ON "payroll_rate_versions"("company_id","effective_from");
-- Partial indexes enforce the same invariant as the transaction advisory lock.
CREATE UNIQUE INDEX "payroll_rates_active_date" ON "payroll_rate_versions"("company_id","effective_from") WHERE NOT is_baseline AND cancelled_at IS NULL;
CREATE UNIQUE INDEX "payroll_rates_one_baseline" ON "payroll_rate_versions"("company_id") WHERE is_baseline;
ALTER TABLE "payroll_runs" ADD COLUMN "rates_snapshot" JSONB, ADD COLUMN "rate_version_id" UUID;
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_rate_version_id_fkey" FOREIGN KEY ("rate_version_id") REFERENCES "payroll_rate_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_rate_versions" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "payroll_rate_versions" FROM PUBLIC, anon, authenticated, service_role;
