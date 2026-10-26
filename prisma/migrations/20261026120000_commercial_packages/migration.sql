-- Additive package catalog. Existing products, documents, keys and receipts stay unchanged.
BEGIN;
CREATE TABLE public.commercial_packages (
 id UUID PRIMARY KEY, company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
 name VARCHAR(150) NOT NULL, draft_definition JSONB NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), active_version INTEGER CHECK(active_version>0),
 archived_at TIMESTAMP(3), created_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(company_id,id),
 CHECK(jsonb_typeof(draft_definition)='object' AND (draft_definition->'schemaVersion') IS NOT DISTINCT FROM '1'::jsonb AND octet_length(draft_definition::text)<=262144)
);
CREATE INDEX idx_commercial_packages_company_list ON public.commercial_packages(company_id,archived_at,id);
CREATE TABLE public.commercial_package_versions (
 id UUID PRIMARY KEY, company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
 package_id UUID NOT NULL, version INTEGER NOT NULL CHECK(version>0), definition JSONB NOT NULL,
 branch_ids UUID[] NOT NULL CHECK(cardinality(branch_ids) BETWEEN 1 AND 100 AND array_position(branch_ids,NULL) IS NULL),
 content_hash VARCHAR(64) NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
 request_key VARCHAR(100) NOT NULL CHECK(request_key ~ '^[A-Za-z0-9._:-]{16,100}$'),
 created_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(company_id,package_id,version), UNIQUE(company_id,package_id,request_key),
 FOREIGN KEY(company_id,package_id) REFERENCES public.commercial_packages(company_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CHECK(jsonb_typeof(definition)='object' AND (definition->'schemaVersion') IS NOT DISTINCT FROM '1'::jsonb AND octet_length(definition::text)<=262144)
);
ALTER TABLE public.commercial_packages ADD CONSTRAINT commercial_package_active_version_fk
 FOREIGN KEY(company_id,id,active_version) REFERENCES public.commercial_package_versions(company_id,package_id,version) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE TABLE public.commercial_package_branches (
 company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
 package_id UUID NOT NULL, branch_id UUID NOT NULL, PRIMARY KEY(package_id,branch_id),
 FOREIGN KEY(company_id,package_id) REFERENCES public.commercial_packages(company_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 FOREIGN KEY(company_id,branch_id) REFERENCES public.branches(company_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX idx_commercial_package_branches_scope ON public.commercial_package_branches(company_id,branch_id,package_id);
CREATE TABLE public.commercial_package_commands (
 id UUID PRIMARY KEY, company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
 actor_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT, package_id UUID NOT NULL,
 action VARCHAR(12) NOT NULL CHECK(action IN ('SAVE','ACTIVATE','ARCHIVE')),
 request_key VARCHAR(100) NOT NULL CHECK(request_key ~ '^[A-Za-z0-9._:-]{16,100}$'),
 input_hash VARCHAR(64) NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'), receipt JSONB NOT NULL,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(company_id,actor_id,action,request_key),
 FOREIGN KEY(company_id,package_id) REFERENCES public.commercial_packages(company_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=16384)
);
CREATE INDEX idx_commercial_package_commands_history ON public.commercial_package_commands(company_id,package_id,created_at);
ALTER TABLE public.commercial_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_package_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_package_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_package_commands ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.auna_immutable_package_version() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 RAISE EXCEPTION 'Activated package versions are immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER commercial_package_version_immutable BEFORE UPDATE OR DELETE ON public.commercial_package_versions
 FOR EACH ROW EXECUTE FUNCTION public.auna_immutable_package_version();

CREATE FUNCTION public.auna_valid_package_groups(value JSONB) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE item JSONB;
BEGIN
 IF value IS NULL THEN RETURN true; END IF;
 IF jsonb_typeof(value)<>'array' OR octet_length(value::text)>262144 THEN RETURN false; END IF;
 IF jsonb_array_length(value)>100 THEN RETURN false; END IF;
 FOR item IN SELECT jsonb_array_elements(value) LOOP
  IF jsonb_typeof(item)<>'object' OR (item->'schemaVersion') IS DISTINCT FROM '1'::jsonb
   OR NOT COALESCE(item->>'state' IN ('INCOMPLETE','COMPLETE'),false) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$$;
ALTER TABLE public.commercial_documents ADD COLUMN package_groups JSONB,
 ADD CONSTRAINT commercial_document_package_groups_check CHECK(public.auna_valid_package_groups(package_groups));
ALTER TABLE public.sales ADD COLUMN package_groups JSONB,
 ADD CONSTRAINT sale_package_groups_check CHECK(public.auna_valid_package_groups(package_groups));
ALTER TABLE public.appointment_engagements ADD COLUMN package_groups JSONB,
 ADD CONSTRAINT engagement_package_groups_check CHECK(public.auna_valid_package_groups(package_groups));
ALTER TABLE public.commercial_document_lines ADD COLUMN package_component_key VARCHAR(73),
 ADD CONSTRAINT document_package_component_key_check CHECK(package_component_key IS NULL OR package_component_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
ALTER TABLE public.sale_items ADD COLUMN package_component_key VARCHAR(73),
 ADD CONSTRAINT sale_package_component_key_check CHECK(package_component_key IS NULL OR package_component_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
ALTER TABLE public.appointment_engagement_lines ADD COLUMN package_component_key VARCHAR(73),
 ADD CONSTRAINT engagement_package_component_key_check CHECK(package_component_key IS NULL OR package_component_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
CREATE INDEX idx_document_package_components ON public.commercial_document_lines(document_id,package_component_key) WHERE package_component_key IS NOT NULL;
CREATE INDEX idx_sale_package_components ON public.sale_items(sale_id,package_component_key) WHERE package_component_key IS NOT NULL;
CREATE INDEX idx_engagement_package_components ON public.appointment_engagement_lines(engagement_id,package_component_key) WHERE package_component_key IS NOT NULL;
COMMIT;
