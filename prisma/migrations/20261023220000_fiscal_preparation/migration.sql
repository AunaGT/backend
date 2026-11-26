BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.fiscal_connector_versions ALTER COLUMN credentials DROP NOT NULL;
ALTER TABLE public.fiscal_connector_versions ADD COLUMN profile jsonb;
ALTER TABLE public.fiscal_connector_versions ADD CONSTRAINT fiscal_version_configuration_check
  CHECK (credentials IS NOT NULL OR profile IS NOT NULL);
ALTER TABLE public.fiscal_connector_versions ADD CONSTRAINT fiscal_profile_size_check
  CHECK (profile IS NULL OR (jsonb_typeof(profile) = 'object' AND octet_length(profile::text) <= 163840));
CREATE TABLE public.fiscal_establishments (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  connector_version_id uuid NOT NULL,
  environment varchar(20) NOT NULL,
  branch_id uuid NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 8192),
  CONSTRAINT fiscal_establishment_version_fk FOREIGN KEY(company_id,connector_version_id,environment)
    REFERENCES public.fiscal_connector_versions(company_id,id,environment) ON DELETE RESTRICT,
  CONSTRAINT fiscal_establishment_branch_fk FOREIGN KEY(company_id,branch_id)
    REFERENCES public.branches(company_id,id) ON DELETE RESTRICT,
  CONSTRAINT fiscal_establishments_connector_version_id_branch_id_key UNIQUE(connector_version_id,branch_id)
);
CREATE INDEX fiscal_establishments_company_id_branch_id_idx ON public.fiscal_establishments(company_id,branch_id);
CREATE TRIGGER fiscal_establishment_immutable BEFORE UPDATE OR DELETE ON public.fiscal_establishments
  FOR EACH ROW EXECUTE FUNCTION public.reject_fiscal_history_mutation();
ALTER TABLE public.fiscal_establishments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fiscal_establishments FROM PUBLIC;
DO $$ DECLARE client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON public.fiscal_establishments FROM %I', client_role);
    END IF;
  END LOOP;
END $$;
COMMIT;
