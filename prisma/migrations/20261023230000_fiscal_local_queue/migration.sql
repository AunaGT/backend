BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE public.fiscal_operations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  connector_version_id uuid NOT NULL,
  environment varchar(20) NOT NULL DEFAULT 'TEST' CHECK(environment='TEST'),
  mode varchar(30) NOT NULL DEFAULT 'LOCAL_SIMULATION' CHECK(mode='LOCAL_SIMULATION'),
  action varchar(20) NOT NULL DEFAULT 'ISSUE' CHECK(action='ISSUE'),
  source_key uuid NOT NULL,
  created_by uuid NOT NULL,
  identifier varchar(64) NOT NULL UNIQUE CHECK(identifier ~ '^local-[a-f0-9-]{36}$'),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=2621440 AND snapshot @> '{"source":"LOCAL_SAMPLE","externalSendingAllowed":false,"environment":"TEST","verification":"UNCONFIRMED"}' AND snapshot ?& ARRAY['companyId','branchId','saleId','connectorVersionId']),
  snapshot_sha256 varchar(64) NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  xml_bytes bytea CHECK(octet_length(xml_bytes)<=2097152),
  xml_sha256 varchar(64),
  state varchar(20) NOT NULL DEFAULT 'QUEUED' CHECK(state IN('QUEUED','SENDING','UNKNOWN','ACCEPTED','DONE','REJECTED','BLOCKED')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  local_failures integer NOT NULL DEFAULT 0 CHECK(local_failures>=0),
  accepted_attempt_id uuid,
  result jsonb CHECK(result IS NULL OR (jsonb_typeof(result)='object' AND result @> '{"certified":false,"simulationOnly":true}' AND octet_length(result::text)<=4096)),
  error_code varchar(64),
  available_at timestamp(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  lease_token uuid,
  lease_until timestamp(3),
  worker_id varchar(80),
  created_at timestamp(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  updated_at timestamp(3) NOT NULL,
  CONSTRAINT fiscal_operation_connector_fk FOREIGN KEY(company_id,connector_id,environment) REFERENCES public.fiscal_connectors(company_id,id,environment) ON DELETE RESTRICT,
  CONSTRAINT fiscal_operation_version_fk FOREIGN KEY(company_id,connector_version_id,environment) REFERENCES public.fiscal_connector_versions(company_id,id,environment) ON DELETE RESTRICT,
  CONSTRAINT fiscal_operation_branch_fk FOREIGN KEY(company_id,branch_id) REFERENCES public.branches(company_id,id) ON DELETE RESTRICT,
  CONSTRAINT fiscal_operations_company_id_branch_id_action_source_key_key UNIQUE(company_id,branch_id,action,source_key),
  CONSTRAINT fiscal_operations_company_id_id_key UNIQUE(company_id,id),
  CONSTRAINT fiscal_operations_company_id_connector_id_environment_id_key UNIQUE(company_id,connector_id,environment,id),
  CHECK((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK((xml_bytes IS NULL)=(xml_sha256 IS NULL)),
  CHECK((xml_bytes IS NULL AND xml_sha256 IS NULL) OR (xml_bytes IS NOT NULL AND xml_sha256=encode(sha256(xml_bytes),'hex'))),
  CHECK(snapshot->>'companyId'=company_id::text AND snapshot->>'branchId'=branch_id::text AND snapshot->>'connectorVersionId'=connector_version_id::text AND snapshot->>'saleId'=source_key::text),
  CHECK(state<>'SENDING' OR (xml_bytes IS NOT NULL AND attempt_count>0 AND lease_token IS NOT NULL)),
  CHECK(state NOT IN('ACCEPTED','DONE') OR accepted_attempt_id IS NOT NULL),
  CHECK(state<>'DONE' OR result IS NOT NULL),
  CHECK(result IS NULL OR state='DONE')
);
CREATE INDEX fiscal_local_queue_idx ON public.fiscal_operations(available_at,id) WHERE state IN('QUEUED','ACCEPTED');
CREATE INDEX fiscal_local_lease_idx ON public.fiscal_operations(lease_until) WHERE lease_token IS NOT NULL;
CREATE INDEX fiscal_local_activity_idx ON public.fiscal_operations(company_id,branch_id,created_at,id);
CREATE TABLE public.fiscal_attempts (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  number integer NOT NULL CHECK(number>0),
  kind varchar(20) NOT NULL CHECK(kind IN('SEND','LOOKUP')),
  lease_token uuid NOT NULL,
  started_at timestamp(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  finished_at timestamp(3),
  outcome varchar(30) CHECK(outcome IN('LOCAL_ACCEPTED','LOCAL_REJECTED','LOCAL_UNKNOWN')),
  inbox jsonb CHECK(inbox IS NULL OR (jsonb_typeof(inbox)='object' AND inbox @> '{"certified":false}' AND octet_length(inbox::text)<=4096)),
  CONSTRAINT fiscal_attempt_operation_fk FOREIGN KEY(company_id,operation_id) REFERENCES public.fiscal_operations(company_id,id) ON DELETE RESTRICT,
  CONSTRAINT fiscal_attempts_operation_id_number_key UNIQUE(operation_id,number),
  CONSTRAINT fiscal_attempts_company_id_operation_id_id_key UNIQUE(company_id,operation_id,id),
  CHECK((finished_at IS NULL)=(outcome IS NULL)),
  CHECK(inbox IS NULL OR outcome IN('LOCAL_ACCEPTED','LOCAL_REJECTED')),
  CHECK(outcome NOT IN('LOCAL_ACCEPTED','LOCAL_REJECTED') OR inbox IS NOT NULL)
);
ALTER TABLE public.fiscal_operations ADD CONSTRAINT fiscal_operation_accepted_attempt_fk FOREIGN KEY(company_id,id,accepted_attempt_id) REFERENCES public.fiscal_attempts(company_id,operation_id,id) ON DELETE RESTRICT;
ALTER TABLE public.fiscal_events ADD COLUMN operation_id uuid;
ALTER TABLE public.fiscal_events ADD CONSTRAINT fiscal_event_operation_fk FOREIGN KEY(company_id,connector_id,environment,operation_id) REFERENCES public.fiscal_operations(company_id,connector_id,environment,id) ON DELETE RESTRICT;
CREATE FUNCTION public.guard_fiscal_local_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Fiscal evidence is immutable' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.id,NEW.company_id,NEW.branch_id,NEW.connector_id,NEW.connector_version_id,NEW.environment,NEW.mode,NEW.action,NEW.source_key,NEW.created_by,NEW.identifier,NEW.snapshot,NEW.snapshot_sha256,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.branch_id,OLD.connector_id,OLD.connector_version_id,OLD.environment,OLD.mode,OLD.action,OLD.source_key,OLD.created_by,OLD.identifier,OLD.snapshot,OLD.snapshot_sha256,OLD.created_at) THEN RAISE EXCEPTION 'Fiscal source is immutable' USING ERRCODE='23514'; END IF;
  IF OLD.xml_bytes IS NOT NULL AND ROW(NEW.xml_bytes,NEW.xml_sha256) IS DISTINCT FROM ROW(OLD.xml_bytes,OLD.xml_sha256) THEN RAISE EXCEPTION 'Fiscal bytes are immutable' USING ERRCODE='23514'; END IF;
  IF (OLD.state='QUEUED' AND NEW.state NOT IN('QUEUED','SENDING','BLOCKED')) OR (OLD.state='SENDING' AND NEW.state NOT IN('SENDING','UNKNOWN','ACCEPTED','REJECTED')) OR (OLD.state='UNKNOWN' AND NEW.state NOT IN('UNKNOWN','ACCEPTED','REJECTED')) OR (OLD.state='ACCEPTED' AND NEW.state NOT IN('ACCEPTED','DONE','BLOCKED')) OR (OLD.state IN('DONE','REJECTED','BLOCKED') AND NEW.state<>OLD.state) THEN RAISE EXCEPTION 'Illegal fiscal state transition' USING ERRCODE='23514'; END IF;
  IF OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result THEN RAISE EXCEPTION 'Fiscal result is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_local_operation_guard BEFORE UPDATE OR DELETE ON public.fiscal_operations FOR EACH ROW EXECUTE FUNCTION public.guard_fiscal_local_operation();
CREATE FUNCTION public.guard_fiscal_local_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Fiscal evidence is immutable' USING ERRCODE='23514'; END IF;
  IF OLD.finished_at IS NOT NULL OR ROW(NEW.id,NEW.company_id,NEW.operation_id,NEW.number,NEW.kind,NEW.lease_token,NEW.started_at) IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.operation_id,OLD.number,OLD.kind,OLD.lease_token,OLD.started_at) THEN RAISE EXCEPTION 'Fiscal attempt is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_local_attempt_guard BEFORE UPDATE OR DELETE ON public.fiscal_attempts FOR EACH ROW EXECUTE FUNCTION public.guard_fiscal_local_attempt();
ALTER TABLE public.fiscal_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fiscal_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fiscal_operations,public.fiscal_attempts FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('REVOKE ALL ON public.fiscal_operations,public.fiscal_attempts FROM %I',role_name); END IF;
END LOOP; END $$;
COMMIT;
