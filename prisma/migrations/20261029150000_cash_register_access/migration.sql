ALTER TABLE cash_registers ADD COLUMN access_control_version integer NOT NULL DEFAULT 0
  CHECK(access_control_version IN(0,1)),
  ADD CONSTRAINT cash_register_explicit_access_identity CHECK(access_control_version=0 OR
    (money_event_version=1 AND kind='PHYSICAL' AND operation_mode='INDIVIDUAL' AND currency_code IS NOT NULL));

CREATE TABLE cash_register_access (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,
 register_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 active boolean NOT NULL DEFAULT true,created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at timestamptz(3) NOT NULL DEFAULT now(),updated_at timestamptz(3) NOT NULL DEFAULT now(),
 UNIQUE(register_id,user_id),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(branch_id,register_id) REFERENCES cash_registers(branch_id,id) ON DELETE RESTRICT
);
CREATE INDEX cash_register_access_scope_user ON cash_register_access(company_id,branch_id,user_id,active);

CREATE TABLE cash_register_commands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,request_key uuid NOT NULL,
 request_hash varchar(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 action varchar(20) NOT NULL CHECK(action IN('CREATE','CONFIGURE','ACCESS_ENABLE')),
 register_id uuid NOT NULL,before_snapshot jsonb,after_snapshot jsonb NOT NULL,result_snapshot jsonb NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT now(),
 UNIQUE(company_id,branch_id,actor_id,request_key),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(branch_id,register_id) REFERENCES cash_registers(branch_id,id) ON DELETE RESTRICT
);
CREATE INDEX cash_register_commands_register_date ON cash_register_commands(register_id,created_at);

CREATE FUNCTION protect_cash_register_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'cash_register_command_immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER protect_cash_register_command BEFORE UPDATE OR DELETE ON cash_register_commands
 FOR EACH ROW EXECUTE FUNCTION protect_cash_register_command();

CREATE FUNCTION protect_cash_register_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
 IF TG_TABLE_NAME='cash_registers' THEN
  IF TG_OP='INSERT' AND NEW.access_control_version<>0 THEN
   RAISE EXCEPTION 'cash_register_access_enable_explicitly' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NEW.access_control_version IS DISTINCT FROM OLD.access_control_version THEN
   IF OLD.access_control_version<>0 OR NEW.access_control_version<>1 THEN
    RAISE EXCEPTION 'cash_register_access_no_downgrade' USING ERRCODE='23514';
   END IF;
   IF NOT NEW.active OR EXISTS(SELECT 1 FROM cash_register_sessions WHERE cash_register_id=NEW.id AND status='OPEN')
    OR NOT EXISTS(SELECT 1 FROM cash_register_access a JOIN user_companies uc ON uc.company_id=a.company_id AND uc.user_id=a.user_id AND uc.status='ACTIVE'
      JOIN user_branches ub ON ub.branch_id=a.branch_id AND ub.user_id=a.user_id WHERE a.register_id=NEW.id AND a.active) THEN
    RAISE EXCEPTION 'cash_register_access_enable_requirements' USING ERRCODE='23514';
   END IF;
  END IF;
 RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'cash_register_access_history' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id,NEW.company_id,NEW.branch_id,NEW.register_id,NEW.user_id,NEW.created_by,NEW.created_at)
   IS DISTINCT FROM (OLD.id,OLD.company_id,OLD.branch_id,OLD.register_id,OLD.user_id,OLD.created_by,OLD.created_at) THEN
  RAISE EXCEPTION 'cash_register_access_identity_immutable' USING ERRCODE='23514';
 END IF;
 SELECT * INTO r FROM cash_registers WHERE id=NEW.register_id AND branch_id=NEW.branch_id FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'cash_register_access_scope' USING ERRCODE='23503'; END IF;
 IF NEW.active THEN
  PERFORM 1 FROM user_companies uc JOIN user_branches ub ON ub.user_id=uc.user_id
   JOIN branches b ON b.id=ub.branch_id AND b.company_id=uc.company_id
   WHERE uc.user_id=NEW.user_id AND uc.company_id=NEW.company_id AND uc.status='ACTIVE' AND ub.branch_id=NEW.branch_id
   FOR UPDATE OF uc,ub;
  IF NOT FOUND THEN RAISE EXCEPTION 'cash_register_access_membership' USING ERRCODE='23514'; END IF;
 ELSE
  IF r.access_control_version=1 AND EXISTS(SELECT 1 FROM cash_register_sessions WHERE cash_register_id=NEW.register_id AND status='OPEN' AND opened_by_id=NEW.user_id) THEN
   RAISE EXCEPTION 'cash_register_access_owner_active' USING ERRCODE='23514';
  END IF;
 END IF;
 NEW.updated_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_register_access_version BEFORE INSERT OR UPDATE OF access_control_version ON cash_registers
 FOR EACH ROW EXECUTE FUNCTION protect_cash_register_access();
CREATE TRIGGER protect_cash_register_access_member BEFORE INSERT OR UPDATE OR DELETE ON cash_register_access
 FOR EACH ROW EXECUTE FUNCTION protect_cash_register_access();

REVOKE ALL ON TABLE cash_register_access,cash_register_commands FROM PUBLIC;
DO $$ DECLARE client_role text; BEGIN
 FOREACH client_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN
   EXECUTE format('REVOKE ALL ON TABLE cash_register_access,cash_register_commands FROM %I',client_role);
  END IF;
 END LOOP;
END $$;
