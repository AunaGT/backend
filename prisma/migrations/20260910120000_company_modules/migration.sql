-- Módulos contratados por empresa. Se habilita el catálogo completo para las
-- empresas existentes, preservando exactamente su comportamiento actual.
CREATE TYPE "CompanyModuleStatus" AS ENUM ('ACTIVE', 'TRIAL', 'SUSPENDED', 'DISABLED');

CREATE TABLE "company_modules" (
    "company_id" UUID NOT NULL,
    "module_code" VARCHAR(50) NOT NULL,
    "status" "CompanyModuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "config" JSONB,
    "trial_ends_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "suspended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_modules_pkey" PRIMARY KEY ("company_id", "module_code")
);

CREATE INDEX "company_modules_status_idx" ON "company_modules"("status");

ALTER TABLE "company_modules"
ADD CONSTRAINT "company_modules_company_id_fkey"
FOREIGN KEY ("company_id") REFERENCES "companies"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "company_modules" (
    "company_id", "module_code", "status", "activated_at", "created_at", "updated_at"
)
SELECT company."id", module."code", 'ACTIVE'::"CompanyModuleStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "companies" AS company
CROSS JOIN (VALUES
    ('dashboard'),
    ('sales'),
    ('quotes'),
    ('orders'),
    ('inventory'),
    ('inventory-count'),
    ('returns'),
    ('cash-closure'),
    ('contacts'),
    ('receivables'),
    ('merchandise'),
    ('analytics'),
    ('accounting'),
    ('reports'),
    ('alerts'),
    ('promotions'),
    ('catalogs'),
    ('transfers'),
    ('branches'),
    ('hr'),
    ('payroll'),
    ('users'),
    ('config')
) AS module("code")
ON CONFLICT ("company_id", "module_code") DO NOTHING;
