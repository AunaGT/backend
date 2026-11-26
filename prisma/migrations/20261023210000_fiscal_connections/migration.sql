BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.fiscal_connectors (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  provider varchar(30) NOT NULL DEFAULT 'INFILE' CHECK (provider = 'INFILE'),
  environment varchar(20) NOT NULL CHECK (environment IN ('TEST','PRODUCTION')),
  state varchar(30) NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','TESTING','TEST_PASSED','PRODUCTION_READY','PAUSED','REVOKED')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL,
  CONSTRAINT fiscal_connector_identity UNIQUE (company_id,provider,environment),
  CONSTRAINT fiscal_connectors_company_id_id_environment_key UNIQUE (company_id,id,environment)
);

CREATE TABLE public.fiscal_connector_versions (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  connector_id uuid NOT NULL,
  environment varchar(20) NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  credentials jsonb NOT NULL CHECK (
    jsonb_typeof(credentials) = 'object' AND credentials->>'version' = '1'
    AND credentials ?& ARRAY['keyId','iv','tag','ciphertext']
    AND length(credentials->>'ciphertext') BETWEEN 1 AND 65536
  ),
  contract_id varchar(80) NOT NULL DEFAULT 'infile-unified-offline-v1',
  created_by uuid NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fiscal_connector_versions_scope_fk FOREIGN KEY (company_id,connector_id,environment)
    REFERENCES public.fiscal_connectors(company_id,id,environment) ON DELETE RESTRICT,
  CONSTRAINT fiscal_connector_versions_company_id_connector_id_number_key UNIQUE (company_id,connector_id,number),
  CONSTRAINT fiscal_connector_versions_company_id_id_environment_key UNIQUE (company_id,id,environment)
);

CREATE TABLE public.fiscal_events (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  connector_id uuid NOT NULL,
  environment varchar(20) NOT NULL,
  actor_id uuid NOT NULL,
  action varchar(40) NOT NULL,
  request_key varchar(64) NOT NULL,
  input_hash varchar(64) NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  hash_key_id varchar(40) NOT NULL,
  result jsonb NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fiscal_event_scope_fk FOREIGN KEY (company_id,connector_id,environment)
    REFERENCES public.fiscal_connectors(company_id,id,environment) ON DELETE RESTRICT,
  CONSTRAINT fiscal_event_request_identity UNIQUE (company_id,actor_id,action,request_key)
);
CREATE INDEX fiscal_events_company_id_environment_created_at_id_idx
  ON public.fiscal_events(company_id,environment,created_at,id);

CREATE FUNCTION public.reject_fiscal_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Fiscal history is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER fiscal_version_immutable BEFORE UPDATE OR DELETE ON public.fiscal_connector_versions
  FOR EACH ROW EXECUTE FUNCTION public.reject_fiscal_history_mutation();
CREATE TRIGGER fiscal_event_immutable BEFORE UPDATE OR DELETE ON public.fiscal_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_fiscal_history_mutation();

ALTER TABLE public.fiscal_connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fiscal_connector_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fiscal_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fiscal_connectors, public.fiscal_connector_versions, public.fiscal_events FROM PUBLIC;
DO $$ DECLARE client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON public.fiscal_connectors, public.fiscal_connector_versions, public.fiscal_events FROM %I', client_role);
    END IF;
  END LOOP;
END $$;
COMMIT;
