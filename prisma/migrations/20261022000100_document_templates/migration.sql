-- CreateTable
CREATE TABLE "public"."document_templates" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "purpose" VARCHAR(30) NOT NULL,
    "format" VARCHAR(20) NOT NULL,
    "base_id" VARCHAR(30) NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."document_template_versions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "design" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "design_hash" VARCHAR(64) NOT NULL,
    "created_by" UUID NOT NULL,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."document_template_defaults" (
    "company_id" UUID NOT NULL,
    "purpose" VARCHAR(30) NOT NULL,
    "format" VARCHAR(20) NOT NULL,
    "version_id" UUID NOT NULL,

    CONSTRAINT "document_template_defaults_pkey" PRIMARY KEY ("company_id","purpose","format")
);

-- CreateTable
CREATE TABLE "public"."document_template_assets" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "path" VARCHAR(500) NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_template_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."document_snapshots" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID,
    "sale_id" UUID,
    "purpose" VARCHAR(30) NOT NULL,
    "source_kind" VARCHAR(20) NOT NULL,
    "actor_id" UUID NOT NULL,
    "scenario" VARCHAR(20),
    "expires_at" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "profiles" JSONB NOT NULL,
    "branding" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."document_artifacts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "format" VARCHAR(20) NOT NULL,
    "profile_hash" VARCHAR(64) NOT NULL,
    "renderer_version" VARCHAR(30) NOT NULL,
    "profile" JSONB NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "lease_until" TIMESTAMP(3),
    "error_code" VARCHAR(80),
    "path" VARCHAR(500),
    "sha256" VARCHAR(64),
    "bytes" INTEGER,
    "page_count" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."document_events" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" VARCHAR(40) NOT NULL,
    "request_key" VARCHAR(120) NOT NULL,
    "input_hash" VARCHAR(64) NOT NULL,
    "entity_id" UUID,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_templates_company_id_state_updated_at_id_idx" ON "public"."document_templates"("company_id", "state", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_templates_company_id_id_key" ON "public"."document_templates"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_template_versions_company_id_id_key" ON "public"."document_template_versions"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_template_versions_company_id_template_id_number_key" ON "public"."document_template_versions"("company_id", "template_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "document_template_assets_path_key" ON "public"."document_template_assets"("path");

-- CreateIndex
CREATE UNIQUE INDEX "document_template_assets_company_id_id_key" ON "public"."document_template_assets"("company_id", "id");

-- CreateIndex
CREATE INDEX "document_snapshots_company_id_branch_id_sale_id_idx" ON "public"."document_snapshots"("company_id", "branch_id", "sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_snapshots_company_id_id_key" ON "public"."document_snapshots"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_artifacts_path_key" ON "public"."document_artifacts"("path");

-- CreateIndex
CREATE UNIQUE INDEX "document_artifacts_company_id_id_key" ON "public"."document_artifacts"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_artifact_identity" ON "public"."document_artifacts"("company_id", "snapshot_id", "format", "profile_hash", "renderer_version");

-- CreateIndex
CREATE INDEX "document_events_company_id_created_at_id_idx" ON "public"."document_events"("company_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_events_company_id_actor_id_action_request_key_key" ON "public"."document_events"("company_id", "actor_id", "action", "request_key");

-- AddForeignKey
ALTER TABLE "public"."document_templates" ADD CONSTRAINT "document_templates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_template_versions" ADD CONSTRAINT "document_template_versions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_template_versions" ADD CONSTRAINT "document_template_versions_company_id_template_id_fkey" FOREIGN KEY ("company_id", "template_id") REFERENCES "public"."document_templates"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_template_defaults" ADD CONSTRAINT "document_template_defaults_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_template_defaults" ADD CONSTRAINT "document_template_defaults_company_id_version_id_fkey" FOREIGN KEY ("company_id", "version_id") REFERENCES "public"."document_template_versions"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_template_assets" ADD CONSTRAINT "document_template_assets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_template_assets" ADD CONSTRAINT "document_template_assets_company_id_template_id_fkey" FOREIGN KEY ("company_id", "template_id") REFERENCES "public"."document_templates"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_template_assets" ADD CONSTRAINT "document_template_assets_company_id_version_id_fkey" FOREIGN KEY ("company_id", "version_id") REFERENCES "public"."document_template_versions"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_snapshots" ADD CONSTRAINT "document_snapshots_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_snapshots" ADD CONSTRAINT "document_snapshots_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "public"."branches"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_snapshots" ADD CONSTRAINT "document_snapshots_branch_id_sale_id_fkey" FOREIGN KEY ("branch_id", "sale_id") REFERENCES "public"."sales"("branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_artifacts" ADD CONSTRAINT "document_artifacts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_artifacts" ADD CONSTRAINT "document_artifacts_company_id_snapshot_id_fkey" FOREIGN KEY ("company_id", "snapshot_id") REFERENCES "public"."document_snapshots"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_events" ADD CONSTRAINT "document_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Formats share one original. Previews cannot occupy that identity.
ALTER TABLE document_template_versions ADD COLUMN resource_refs JSONB NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX document_original_identity ON document_snapshots(company_id,branch_id,sale_id,purpose) WHERE source_kind='SALE';
CREATE INDEX document_queue_due ON document_artifacts(available_at,id) WHERE state IN ('QUEUED','RENDERING');
ALTER TABLE document_snapshots ADD CONSTRAINT document_snapshot_source CHECK (
 (source_kind='SALE' AND sale_id IS NOT NULL AND branch_id IS NOT NULL AND expires_at IS NULL AND purpose='INTERNAL_RECEIPT') OR
 (source_kind='PREVIEW' AND sale_id IS NULL AND expires_at IS NOT NULL AND scenario IN ('SHORT','LONG','LONG_TEXT','REAL_SALE'))
);
ALTER TABLE document_templates ADD CONSTRAINT document_template_values CHECK (purpose IN ('INTERNAL_RECEIPT','FEL_INVOICE') AND format IN ('LETTER','A4','RECEIPT_80') AND state IN ('ACTIVE','ARCHIVED') AND revision>0);
ALTER TABLE document_template_versions ADD CONSTRAINT document_version_values CHECK (state IN ('DRAFT','PUBLISHED') AND schema_version=1 AND number>0 AND (state<>'PUBLISHED' OR published_at IS NOT NULL));
ALTER TABLE document_artifacts ADD CONSTRAINT document_artifact_values CHECK (state IN ('QUEUED','RENDERING','READY','FAILED') AND attempts>=0 AND length(profile_hash)=64 AND (state<>'READY' OR (path IS NOT NULL AND sha256 IS NOT NULL AND bytes>0 AND page_count>0)));
ALTER TABLE document_template_versions ADD CONSTRAINT document_version_full_identity UNIQUE(company_id,template_id,id);
ALTER TABLE document_template_assets ADD CONSTRAINT document_asset_own_version FOREIGN KEY(company_id,template_id,version_id) REFERENCES document_template_versions(company_id,template_id,id) ON DELETE RESTRICT;

CREATE FUNCTION auna_document_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='PUBLISHED' THEN RAISE EXCEPTION 'Published document versions are immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER document_version_immutable BEFORE UPDATE OR DELETE ON document_template_versions FOR EACH ROW EXECUTE FUNCTION auna_document_version_guard();

CREATE FUNCTION auna_document_original_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Document snapshots and audit events are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER document_snapshot_immutable BEFORE UPDATE OR DELETE ON document_snapshots FOR EACH ROW EXECUTE FUNCTION auna_document_original_guard();
CREATE TRIGGER document_event_immutable BEFORE UPDATE OR DELETE ON document_events FOR EACH ROW EXECUTE FUNCTION auna_document_original_guard();

CREATE FUNCTION auna_document_default_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM document_template_versions v JOIN document_templates t ON t.id=v.template_id AND t.company_id=v.company_id
 WHERE v.id=NEW.version_id AND v.company_id=NEW.company_id AND v.state='PUBLISHED' AND t.state='ACTIVE' AND t.purpose=NEW.purpose AND t.format=NEW.format) THEN
  RAISE EXCEPTION 'A document default must reference a compatible published company version' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER document_default_valid BEFORE INSERT OR UPDATE ON document_template_defaults FOR EACH ROW EXECUTE FUNCTION auna_document_default_guard();

CREATE FUNCTION auna_document_artifact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='READY' THEN RAISE EXCEPTION 'Ready document originals are immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF (OLD.company_id,OLD.snapshot_id,OLD.format,OLD.profile_hash,OLD.renderer_version,OLD.profile) IS DISTINCT FROM
    (NEW.company_id,NEW.snapshot_id,NEW.format,NEW.profile_hash,NEW.renderer_version,NEW.profile) THEN
  RAISE EXCEPTION 'A document job cannot change its original input' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER document_artifact_immutable BEFORE UPDATE OR DELETE ON document_artifacts FOR EACH ROW EXECUTE FUNCTION auna_document_artifact_guard();

ALTER TABLE document_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_template_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_template_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_events ENABLE ROW LEVEL SECURITY;
