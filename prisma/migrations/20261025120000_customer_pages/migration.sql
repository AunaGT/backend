-- Additive only: no existing document, share token or fiscal setting is modified.
CREATE TABLE "portal_templates" (
 "id" UUID PRIMARY KEY, "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
 "name" VARCHAR(150) NOT NULL, "document_type" VARCHAR(10) NOT NULL CHECK ("document_type" IN ('QUOTE','ORDER')),
 "state" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK ("state" IN ('ACTIVE','ARCHIVED')),
 "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision">0), "created_by" UUID NOT NULL,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
 UNIQUE("company_id","id")
);
CREATE INDEX "portal_templates_company_id_state_updated_at_id_idx" ON "portal_templates"("company_id","state","updated_at","id");
CREATE TABLE "portal_template_versions" (
 "id" UUID PRIMARY KEY, "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
 "template_id" UUID NOT NULL, "number" INTEGER NOT NULL CHECK ("number">0),
 "state" VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK ("state" IN ('DRAFT','PUBLISHED')),
 "renderer_version" INTEGER NOT NULL DEFAULT 1, "design" JSONB NOT NULL,
 "design_hash" VARCHAR(64) NOT NULL, "code_hash" VARCHAR(64) NOT NULL, "custom_artifacts" JSONB NOT NULL DEFAULT '{}',
 "acknowledged_code_hash" VARCHAR(64), "created_by" UUID NOT NULL,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "published_at" TIMESTAMP(3),
 UNIQUE("company_id","id"), UNIQUE("company_id","template_id","number"),
 FOREIGN KEY("company_id","template_id") REFERENCES "portal_templates"("company_id","id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "portal_one_draft_per_template" ON "portal_template_versions"("company_id","template_id") WHERE "state"='DRAFT';
CREATE TABLE "portal_template_defaults" (
 "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
 "document_type" VARCHAR(10) NOT NULL CHECK ("document_type" IN ('QUOTE','ORDER')), "version_id" UUID NOT NULL,
 PRIMARY KEY("company_id","document_type"), FOREIGN KEY("company_id","version_id") REFERENCES "portal_template_versions"("company_id","id") ON DELETE RESTRICT
);
CREATE TABLE "portal_assets" (
 "id" UUID PRIMARY KEY, "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
 "template_id" UUID NOT NULL, "path" VARCHAR(500) NOT NULL UNIQUE, "sha256" VARCHAR(64) NOT NULL,
 "width" INTEGER NOT NULL CHECK ("width">0), "height" INTEGER NOT NULL CHECK ("height">0), "bytes" INTEGER NOT NULL CHECK ("bytes">0),
 "created_by" UUID NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("company_id","id"), FOREIGN KEY("company_id","template_id") REFERENCES "portal_templates"("company_id","id") ON DELETE RESTRICT
);
CREATE INDEX "portal_assets_company_id_template_id_created_at_idx" ON "portal_assets"("company_id","template_id","created_at");
CREATE TABLE "portal_saved_sections" (
 "id" UUID PRIMARY KEY, "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
 "name" VARCHAR(150) NOT NULL, "document_type" VARCHAR(10) NOT NULL CHECK ("document_type" IN ('QUOTE','ORDER')),
 "design" JSONB NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision">0), "created_by" UUID NOT NULL,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE("company_id","id")
);
CREATE INDEX "portal_saved_sections_company_id_created_at_idx" ON "portal_saved_sections"("company_id","created_at");
CREATE TABLE "portal_write_receipts" (
 "id" UUID PRIMARY KEY, "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
 "actor_id" UUID NOT NULL, "request_id" UUID NOT NULL, "input_hash" VARCHAR(64) NOT NULL,
 "result" JSONB NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("company_id","actor_id","request_id")
);
CREATE TABLE "portal_audits" (
 "id" UUID PRIMARY KEY, "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
 "actor_id" UUID NOT NULL, "template_id" UUID NOT NULL, "action" VARCHAR(30) NOT NULL,
 "revision" INTEGER NOT NULL, "design_hash" VARCHAR(64), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "portal_audits_company_id_template_id_created_at_idx" ON "portal_audits"("company_id","template_id","created_at");
CREATE TABLE "portal_code_policies" (
 "company_id" UUID PRIMARY KEY REFERENCES "companies"("id") ON DELETE RESTRICT,
 "enabled" BOOLEAN NOT NULL DEFAULT false, "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision">0),
 "updated_by" UUID NOT NULL, "updated_at" TIMESTAMP(3) NOT NULL
);
-- These tables are server-only. Supabase public/anonymous API gets no policy.
ALTER TABLE "portal_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portal_template_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portal_template_defaults" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portal_assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portal_saved_sections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portal_write_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portal_audits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portal_code_policies" ENABLE ROW LEVEL SECURITY;
