-- Cajas 3C: política de diferencias, reconteo por arqueo sustituto y revisión auditada.
-- Los arqueos anteriores quedan en el flujo 0 sin conversión; el flujo 1 aplica a arqueos nuevos de turnos con libro.
CREATE TABLE cash_difference_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,branch_id uuid,
 cash_threshold numeric(12,2) NOT NULL DEFAULT 0 CHECK(cash_threshold>=0 AND cash_threshold<=9999999999.99),
 digital_threshold numeric(12,2) NOT NULL DEFAULT 0 CHECK(digital_threshold>=0 AND digital_threshold<=9999999999.99),
 blind_count boolean NOT NULL DEFAULT false,owner_self_review boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),updated_by_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 -- La excepción del dueño que opera solo es una decisión de toda la empresa.
 CHECK(branch_id IS NULL OR NOT owner_self_review),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX cash_difference_policies_scope ON cash_difference_policies(company_id,coalesce(branch_id,'00000000-0000-0000-0000-000000000000'::uuid));

ALTER TABLE cash_closures
 ADD COLUMN review_flow_version integer NOT NULL DEFAULT 0 CHECK(review_flow_version IN(0,1)),
 ADD COLUMN supersedes_closure_id uuid UNIQUE REFERENCES cash_closures(id) ON DELETE RESTRICT,
 ADD COLUMN policy_snapshot jsonb,
 ADD COLUMN review_result varchar(8) CHECK(review_result IN('CLEAN','WITHIN','REVIEW')),
 ADD COLUMN review_classification jsonb,
 ADD CONSTRAINT cash_closures_review_flow CHECK(review_flow_version=0 AND supersedes_closure_id IS NULL AND policy_snapshot IS NULL AND review_result IS NULL AND review_classification IS NULL
  OR review_flow_version=1 AND policy_snapshot IS NOT NULL AND review_result IS NOT NULL AND review_classification IS NOT NULL);

CREATE TABLE cash_closure_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),cash_closure_id uuid NOT NULL REFERENCES cash_closures(id) ON DELETE RESTRICT,
 action varchar(24) NOT NULL CHECK(action IN('RECOUNT_REQUESTED','DIFFERENCES_ACCEPTED','FINALIZED')),
 reason varchar(1000),actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,self_review boolean NOT NULL DEFAULT false,
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(cash_closure_id,action),
 CHECK(action='FINALIZED' OR length(btrim(coalesce(reason,'')))>0)
);

CREATE FUNCTION protect_cash_closure_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE closure record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'cash_review_immutable' USING ERRCODE='23514'; END IF;
 SELECT * INTO closure FROM cash_closures WHERE id=NEW.cash_closure_id FOR UPDATE;
 IF closure.review_flow_version<>1 OR closure.status<>'Pendiente' THEN RAISE EXCEPTION 'cash_review_state' USING ERRCODE='23514'; END IF;
 NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_closure_review BEFORE INSERT OR UPDATE OR DELETE ON cash_closure_reviews FOR EACH ROW EXECUTE FUNCTION protect_cash_closure_review();

-- Transiciones del flujo nuevo. Se suma a protect_cash_closure_snapshot (importes congelados) sin reemplazarlo.
CREATE FUNCTION protect_cash_review_flow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.review_flow_version=1 THEN RAISE EXCEPTION 'cash_review_immutable' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF OLD.review_flow_version=0 THEN
  IF NEW.review_flow_version=0 THEN RETURN NEW; END IF;
  -- Entrada única al flujo nuevo: un arqueo recién presentado, sin revisión previa.
  IF OLD.status<>'Pendiente' OR NEW.status<>'Pendiente' OR OLD.supervisor_id IS NOT NULL THEN RAISE EXCEPTION 'cash_review_state' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.review_flow_version<>1 OR (NEW.supersedes_closure_id,NEW.policy_snapshot,NEW.review_result,NEW.review_classification)
  IS DISTINCT FROM (OLD.supersedes_closure_id,OLD.policy_snapshot,OLD.review_result,OLD.review_classification) THEN
  RAISE EXCEPTION 'cash_review_immutable' USING ERRCODE='23514'; END IF;
 IF NEW.status IS DISTINCT FROM OLD.status THEN
  IF NOT (OLD.status='Pendiente' AND NEW.status IN('Reconteo','Aprobado') OR OLD.status='Reconteo' AND NEW.status='Sustituido') THEN
   RAISE EXCEPTION 'cash_review_state' USING ERRCODE='23514'; END IF;
  IF NEW.status='Reconteo' AND NOT EXISTS(SELECT 1 FROM cash_closure_reviews WHERE cash_closure_id=OLD.id AND action='RECOUNT_REQUESTED')
   OR NEW.status='Aprobado' AND (NOT EXISTS(SELECT 1 FROM cash_closure_reviews WHERE cash_closure_id=OLD.id AND action='FINALIZED')
    OR OLD.review_result='REVIEW' AND NOT EXISTS(SELECT 1 FROM cash_closure_reviews WHERE cash_closure_id=OLD.id AND action='DIFFERENCES_ACCEPTED'))
   OR NEW.status='Sustituido' AND NOT EXISTS(SELECT 1 FROM cash_closures WHERE supersedes_closure_id=OLD.id) THEN
   RAISE EXCEPTION 'cash_review_state' USING ERRCODE='23514'; END IF;
 ELSIF OLD.status IN('Aprobado','Sustituido') AND (NEW.supervisor_id,NEW.supervisor_signature,NEW.supervisor_validated_at,NEW.notes)
  IS DISTINCT FROM (OLD.supervisor_id,OLD.supervisor_signature,OLD.supervisor_validated_at,OLD.notes) THEN
  RAISE EXCEPTION 'cash_review_immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_review_flow BEFORE UPDATE OR DELETE ON cash_closures FOR EACH ROW EXECUTE FUNCTION protect_cash_review_flow();

-- Un arqueo sustituto solo existe para uno en reconteo del mismo turno, cajero y sucursal.
CREATE FUNCTION require_cash_closure_recount() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous record;
BEGIN
 IF NEW.supersedes_closure_id IS NULL OR TG_OP='UPDATE' AND NEW.supersedes_closure_id IS NOT DISTINCT FROM OLD.supersedes_closure_id THEN RETURN NULL; END IF;
 SELECT * INTO previous FROM cash_closures WHERE id=NEW.supersedes_closure_id;
 IF previous.status NOT IN('Reconteo','Sustituido') OR previous.branch_id<>NEW.branch_id OR previous.cashier_id IS DISTINCT FROM NEW.cashier_id
  OR NOT EXISTS(SELECT 1 FROM cash_register_sessions WHERE cash_closure_id=NEW.id) THEN
  RAISE EXCEPTION 'cash_review_recount' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER require_cash_closure_recount AFTER INSERT OR UPDATE OF supersedes_closure_id ON cash_closures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cash_closure_recount();

-- Excepción del dueño que opera solo: recibir un traslado propio (3B.2) exige la excepción de la empresa.
-- La autorrecepción queda visible e inmutable como receiver_id = sender_id.
DO $$ DECLARE c text; BEGIN
 SELECT conname INTO c FROM pg_constraint WHERE conrelid='cash_custody_transfers'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%receiver_id <> sender_id%';
 IF c IS NULL THEN RAISE EXCEPTION 'cash_review_migration: receiver check not found'; END IF;
 EXECUTE format('ALTER TABLE cash_custody_transfers DROP CONSTRAINT %I',c);
END $$;
CREATE FUNCTION require_cash_custody_self_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.receiver_id=NEW.sender_id AND (NEW.status<>'RECEIVED' OR NOT EXISTS(SELECT 1 FROM cash_difference_policies WHERE company_id=NEW.company_id AND branch_id IS NULL AND owner_self_review)) THEN
  RAISE EXCEPTION 'cash_custody_self_receipt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER require_cash_custody_self_receipt BEFORE UPDATE OF receiver_id ON cash_custody_transfers FOR EACH ROW EXECUTE FUNCTION require_cash_custody_self_receipt();

DO $$ DECLARE client_role text; t text; BEGIN
 FOREACH t IN ARRAY ARRAY['cash_difference_policies','cash_closure_reviews'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',t);
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',t,client_role); END IF;
  END LOOP;
 END LOOP;
END $$;
