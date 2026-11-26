-- Cajas6: compartidas físicas explícitas. No convierte cajas ni turnos existentes.
-- En compartidas el declarante puede cambiar; ambos snapshots deben acreditar el mismo turno.
CREATE OR REPLACE FUNCTION require_cash_closure_recount() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous record;
BEGIN
 IF NEW.supersedes_closure_id IS NULL OR TG_OP='UPDATE' AND NEW.supersedes_closure_id IS NOT DISTINCT FROM OLD.supersedes_closure_id THEN RETURN NULL; END IF;
 SELECT * INTO previous FROM cash_closures WHERE id=NEW.supersedes_closure_id;
 IF previous.status NOT IN('Reconteo','Sustituido') OR previous.branch_id<>NEW.branch_id
  OR (previous.cashier_id IS DISTINCT FROM NEW.cashier_id AND NOT EXISTS(
   SELECT 1 FROM cash_register_sessions s WHERE s.cash_closure_id=NEW.id AND s.operation_mode='SHARED' AND s.money_event_version=1
    AND previous.calculation_snapshot->'cash_session'->>'id'=s.id::text AND NEW.calculation_snapshot->'cash_session'->>'id'=s.id::text))
  OR NOT EXISTS(SELECT 1 FROM cash_register_sessions WHERE cash_closure_id=NEW.id) THEN
  RAISE EXCEPTION 'cash_review_recount' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION protect_cash_register_access() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF r.access_control_version=1 AND r.operation_mode='INDIVIDUAL' AND EXISTS(SELECT 1 FROM cash_register_sessions WHERE cash_register_id=NEW.register_id AND status='OPEN' AND opened_by_id=NEW.user_id) THEN
   RAISE EXCEPTION 'cash_register_access_owner_active' USING ERRCODE='23514';
  END IF;
 END IF;
 NEW.updated_at=clock_timestamp(); RETURN NEW;
END $$;
ALTER TABLE cash_registers DROP CONSTRAINT cash_event_register_identity,
 ADD CONSTRAINT cash_event_register_identity CHECK(money_event_version=0 OR currency_code IS NOT NULL AND
 (operation_mode='INDIVIDUAL' OR kind='PHYSICAL' AND operation_mode='SHARED' AND access_control_version=1));
ALTER TABLE cash_registers DROP CONSTRAINT cash_register_explicit_access_identity,
 ADD CONSTRAINT cash_register_explicit_access_identity CHECK(access_control_version=0 OR
 (money_event_version=1 AND kind='PHYSICAL' AND currency_code IS NOT NULL));
CREATE OR REPLACE FUNCTION protect_cash_event_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent record;
BEGIN
  IF TG_TABLE_NAME='cash_registers' THEN
    IF NEW.money_event_version<>OLD.money_event_version THEN
      IF OLD.money_event_version=1 OR NEW.kind NOT IN('PHYSICAL','VIRTUAL') OR (NEW.operation_mode='SHARED' AND (NEW.kind<>'PHYSICAL' OR NEW.access_control_version<>1)) OR NEW.currency_code IS NULL
        OR EXISTS(SELECT 1 FROM cash_register_sessions WHERE cash_register_id=OLD.id AND status='OPEN') THEN
        RAISE EXCEPTION 'cash_event_register: adoption requires a configured individual box without an open turn; cannot downgrade' USING ERRCODE='23514';
      END IF;
    END IF;
  ELSE
    IF TG_OP='UPDATE' THEN
      IF NEW.money_event_version IS DISTINCT FROM OLD.money_event_version OR NEW.business_timezone IS DISTINCT FROM OLD.business_timezone
        OR NEW.opening_cash_method_id IS DISTINCT FROM OLD.opening_cash_method_id OR NEW.opening_cash_method_name IS DISTINCT FROM OLD.opening_cash_method_name
        OR OLD.money_event_version=1 AND (NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.opened_by_id IS DISTINCT FROM OLD.opened_by_id) THEN
        RAISE EXCEPTION 'cash_event_session: version and timezone are frozen at opening' USING ERRCODE='23514';
      END IF;
    ELSE
      SELECT * INTO parent FROM cash_registers WHERE id=NEW.cash_register_id FOR UPDATE;
      IF NEW.money_event_version<>parent.money_event_version THEN
        RAISE EXCEPTION 'cash_event_session: old writer cannot downgrade a ledger register' USING ERRCODE='23514';
      END IF;
      IF NEW.money_event_version=1 AND NEW.opening_float>0 AND NOT EXISTS(
        SELECT 1 FROM payment_methods pm JOIN company_payment_methods cp ON cp.payment_method_id=pm.id
        JOIN branches b ON b.id=parent.branch_id WHERE pm.id=NEW.opening_cash_method_id AND cp.company_id=b.company_id
        AND cp.enabled AND pm.settlement_kind='CASH' AND NOT pm.is_credit AND (pm.company_id IS NULL OR pm.company_id=b.company_id)
        AND pm.name=NEW.opening_cash_method_name) THEN
        RAISE EXCEPTION 'cash_event_session: opening float requires a frozen company CASH method' USING ERRCODE='23514';
      END IF;
    END IF;
    IF NEW.money_event_version=1 AND NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=NEW.business_timezone) THEN
      RAISE EXCEPTION 'cash_event_session: invalid operational timezone' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION protect_cash_physical_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE turn record; method record; original record; available numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'cash_physical_immutable' USING ERRCODE='23514'; END IF;
 SELECT s.*,r.branch_id,r.active,b.company_id INTO turn FROM cash_register_sessions s
  JOIN cash_registers r ON r.id=s.cash_register_id JOIN branches b ON b.id=r.branch_id WHERE s.id=NEW.cash_register_session_id FOR UPDATE OF s;
 IF turn.id IS NULL OR turn.status<>'OPEN' OR turn.money_event_version<>1 OR NOT turn.active
  OR turn.register_type<>'PHYSICAL'
  OR (turn.company_id,turn.branch_id,turn.cash_register_id,turn.currency_code) IS DISTINCT FROM
   (NEW.company_id,NEW.branch_id,NEW.cash_register_id,NEW.currency_code) THEN
  RAISE EXCEPTION 'cash_physical_turn' USING ERRCODE='23514';
 END IF;
 SELECT pm.* INTO method FROM payment_methods pm JOIN company_payment_methods cp ON cp.payment_method_id=pm.id
  WHERE pm.id=NEW.payment_method_id AND cp.company_id=NEW.company_id AND cp.enabled;
 IF method.id IS NULL OR method.is_credit OR method.settlement_kind::text IS DISTINCT FROM 'CASH'
  OR method.company_id IS NOT NULL AND method.company_id<>NEW.company_id OR method.name IS DISTINCT FROM NEW.payment_method_name
  OR NOT EXISTS(SELECT 1 FROM system_settings WHERE company_id=NEW.company_id AND key='currency_code' AND value=NEW.currency_code) THEN
  RAISE EXCEPTION 'cash_physical_method' USING ERRCODE='23514';
 END IF;
 IF NEW.corrects_movement_id IS NOT NULL THEN
  SELECT * INTO original FROM cash_physical_movements WHERE id=NEW.corrects_movement_id;
  IF original.id IS NULL OR original.corrects_movement_id IS NOT NULL OR original.id=NEW.id
   OR (original.company_id,original.branch_id,original.currency_code,original.amount) IS DISTINCT FROM (NEW.company_id,NEW.branch_id,NEW.currency_code,NEW.amount)
   OR original.direction=NEW.direction THEN
   RAISE EXCEPTION 'cash_physical_correction' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.direction='OUT' THEN
  SELECT turn.opening_float+coalesce(sum(CASE direction WHEN 'IN' THEN amount ELSE -amount END),0) INTO available
   FROM cash_money_events WHERE cash_register_session_id=turn.id AND settlement_kind='CASH';
  IF NEW.amount>available THEN RAISE EXCEPTION 'cash_physical_insufficient' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.economic_at=clock_timestamp();NEW.created_at=NEW.economic_at;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION protect_cash_custody_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE holder record; available numeric; currency text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'cash_custody_immutable' USING ERRCODE='23514'; END IF;
 SELECT value INTO currency FROM system_settings WHERE company_id=NEW.company_id AND key='currency_code';
 IF currency IS DISTINCT FROM NEW.currency_code THEN RAISE EXCEPTION 'cash_custody_currency' USING ERRCODE='23514'; END IF;
 IF NEW.holder_kind='CUSTODY' THEN
  SELECT c.* INTO holder FROM cash_custodies c WHERE c.id=NEW.custody_id FOR UPDATE;
  IF holder.id IS NULL OR (holder.company_id,holder.branch_id,holder.currency_code) IS DISTINCT FROM (NEW.company_id,NEW.branch_id,NEW.currency_code)
   OR NOT holder.active AND NEW.direction='IN' THEN RAISE EXCEPTION 'cash_custody_holder' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT r.*,b.company_id INTO holder FROM cash_registers r JOIN branches b ON b.id=r.branch_id WHERE r.id=NEW.cash_register_id FOR UPDATE OF r;
  IF holder.id IS NULL OR holder.company_id<>NEW.company_id OR holder.branch_id<>NEW.branch_id OR holder.money_event_version<>1
   OR holder.kind<>'PHYSICAL' OR holder.currency_code IS DISTINCT FROM NEW.currency_code
   THEN RAISE EXCEPTION 'cash_custody_holder' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.holder_kind='SESSION' THEN
  SELECT s.* INTO holder FROM cash_register_sessions s WHERE s.id=NEW.cash_register_session_id FOR UPDATE;
  IF holder.status<>'OPEN' OR holder.money_event_version<>1 OR holder.currency_code IS DISTINCT FROM NEW.currency_code THEN
   RAISE EXCEPTION 'cash_custody_turn' USING ERRCODE='23514'; END IF;
  IF NEW.direction='OUT' THEN
   SELECT holder.opening_float+coalesce(sum(CASE direction WHEN 'IN' THEN amount ELSE -amount END),0) INTO available
    FROM cash_money_events WHERE cash_register_session_id=holder.id AND settlement_kind='CASH';
   IF NEW.amount>available THEN RAISE EXCEPTION 'cash_custody_insufficient' USING ERRCODE='23514'; END IF;
  END IF;
 ELSIF NEW.direction='OUT' AND NEW.amount>cash_custody_balance(NEW.custody_id,NEW.cash_register_id) THEN
  RAISE EXCEPTION 'cash_custody_insufficient' USING ERRCODE='23514';
 END IF;
 -- Abrir consume todo el fondo retenido, nunca una parte.
 IF NEW.leg='OPENING' AND NEW.amount<>cash_custody_balance(NULL,NEW.cash_register_id) THEN
  RAISE EXCEPTION 'cash_custody_opening' USING ERRCODE='23514';
 END IF;
 IF NEW.holder_kind='FLOAT' AND NEW.leg<>'OPENING' AND EXISTS(SELECT 1 FROM cash_register_sessions WHERE cash_register_id=NEW.cash_register_id AND status='OPEN') THEN
  RAISE EXCEPTION 'cash_custody_float_open_turn' USING ERRCODE='23514';
 END IF;
 NEW.economic_at=clock_timestamp();NEW.created_at=NEW.economic_at;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION protect_cash_custody_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE currency text; holder record;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'cash_custody_immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
  -- Única transición: PENDIENTE a RECIBIDO o RECHAZADO; nada más cambia.
  IF OLD.status<>'PENDING' OR NEW.status='PENDING' OR (to_jsonb(NEW)-'status'-'received_amount'-'receiver_id'-'received_at'-'receipt_reason')
   IS DISTINCT FROM (to_jsonb(OLD)-'status'-'received_amount'-'receiver_id'-'received_at'-'receipt_reason') THEN
   RAISE EXCEPTION 'cash_custody_transfer_state' USING ERRCODE='23514'; END IF;
  NEW.received_at=clock_timestamp();
  RETURN NEW;
 END IF;
 IF NEW.status<>'PENDING' THEN RAISE EXCEPTION 'cash_custody_transfer_state' USING ERRCODE='23514'; END IF;
 SELECT value INTO currency FROM system_settings WHERE company_id=NEW.company_id AND key='currency_code';
 IF currency IS DISTINCT FROM NEW.currency_code THEN RAISE EXCEPTION 'cash_custody_currency' USING ERRCODE='23514'; END IF;
 IF NEW.destination_kind='CUSTODY' THEN
  SELECT * INTO holder FROM cash_custodies WHERE id=NEW.destination_custody_id;
  IF NOT holder.active OR holder.currency_code<>NEW.currency_code OR NEW.destination_custody_id IS NOT DISTINCT FROM NEW.origin_custody_id THEN
   RAISE EXCEPTION 'cash_custody_destination' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO holder FROM cash_registers WHERE id=NEW.destination_register_id;
  IF NOT holder.active OR holder.money_event_version<>1 OR holder.kind<>'PHYSICAL'
   OR holder.currency_code IS DISTINCT FROM NEW.currency_code OR NEW.origin_kind IN('SESSION','FLOAT') AND NEW.destination_register_id=NEW.origin_register_id THEN
   RAISE EXCEPTION 'cash_custody_destination' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION protect_cash_turn_handover() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE turn record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'cash_custody_immutable' USING ERRCODE='23514'; END IF;
 SELECT s.*,r.branch_id,b.company_id INTO turn FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.cash_register_id
  JOIN branches b ON b.id=r.branch_id WHERE s.id=NEW.cash_register_session_id FOR UPDATE OF s;
 IF turn.id IS NULL OR turn.status<>'CLOSED' OR turn.money_event_version<>1 OR turn.register_type<>'PHYSICAL'
  OR (turn.company_id,turn.branch_id,turn.cash_register_id,turn.currency_code) IS DISTINCT FROM (NEW.company_id,NEW.branch_id,NEW.cash_register_id,NEW.currency_code) THEN
  RAISE EXCEPTION 'cash_custody_handover_turn' USING ERRCODE='23514'; END IF;
 NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;

CREATE TABLE cash_session_participants (
 session_id uuid NOT NULL REFERENCES cash_register_sessions(id) ON DELETE RESTRICT,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 joined_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(session_id,user_id)
);
CREATE INDEX cash_session_participants_user ON cash_session_participants(user_id,session_id);
CREATE FUNCTION protect_cash_shared_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.money_event_version=1 AND NEW.operation_mode='SHARED' AND
 (TG_OP='INSERT' OR OLD.operation_mode IS DISTINCT FROM NEW.operation_mode OR OLD.money_event_version IS DISTINCT FROM NEW.money_event_version) THEN
  IF (SELECT count(*) FROM cash_register_access a JOIN user_companies uc ON uc.user_id=a.user_id AND uc.company_id=a.company_id AND uc.status='ACTIVE'
   JOIN user_branches ub ON ub.user_id=a.user_id AND ub.branch_id=a.branch_id WHERE a.register_id=NEW.id AND a.active)<2 THEN
   RAISE EXCEPTION 'cash_shared_two_members' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_shared_configuration BEFORE INSERT OR UPDATE ON cash_registers FOR EACH ROW EXECUTE FUNCTION protect_cash_shared_configuration();
CREATE FUNCTION protect_cash_session_participant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE turn record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'cash_participant_immutable' USING ERRCODE='23514'; END IF;
 SELECT s.*,r.branch_id,r.access_control_version,b.company_id INTO turn FROM cash_register_sessions s
 JOIN cash_registers r ON r.id=s.cash_register_id JOIN branches b ON b.id=r.branch_id WHERE s.id=NEW.session_id FOR UPDATE OF s;
 IF turn.status<>'OPEN' OR turn.money_event_version<>1 OR turn.operation_mode<>'SHARED' OR turn.register_type<>'PHYSICAL' OR turn.access_control_version<>1 THEN
  RAISE EXCEPTION 'cash_participant_turn' USING ERRCODE='23514';
 END IF;
 PERFORM 1 FROM cash_register_access a JOIN user_companies uc ON uc.user_id=a.user_id AND uc.company_id=a.company_id AND uc.status='ACTIVE'
 JOIN user_branches ub ON ub.user_id=a.user_id AND ub.branch_id=a.branch_id
 WHERE a.register_id=turn.cash_register_id AND a.company_id=turn.company_id AND a.branch_id=turn.branch_id AND a.user_id=NEW.user_id AND a.active FOR SHARE OF a,uc,ub;
 IF NOT FOUND THEN RAISE EXCEPTION 'cash_participant_access' USING ERRCODE='23514'; END IF;
 NEW.joined_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_session_participant BEFORE INSERT OR UPDATE OR DELETE ON cash_session_participants FOR EACH ROW EXECUTE FUNCTION protect_cash_session_participant();
CREATE FUNCTION cash_shared_opened() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.money_event_version=1 AND NEW.operation_mode='SHARED' THEN
  INSERT INTO cash_session_participants(session_id,user_id) VALUES(NEW.id,NEW.opened_by_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cash_shared_opened AFTER INSERT ON cash_register_sessions FOR EACH ROW EXECUTE FUNCTION cash_shared_opened();
REVOKE ALL ON TABLE cash_session_participants FROM PUBLIC;
ALTER TABLE cash_session_participants ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE client_role text; BEGIN
 FOREACH client_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN
   EXECUTE format('REVOKE ALL ON TABLE cash_session_participants FROM %I',client_role);
  END IF;
 END LOOP;
END $$;
