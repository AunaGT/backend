-- Cajas 4A: períodos de caja virtual con libro de eventos, y avisos de pago con confirmación manual.
-- Una caja virtual individual adopta el libro (2B.2 solo admitía físicas). Fondo 0 y solo medios BANK ya lo exigen
-- cash_session_virtual_float_check y la guarda de eventos de 2B.2; traslados y movimientos físicos siguen exigiendo caja física.
ALTER TABLE cash_registers DROP CONSTRAINT cash_event_register_identity,
  ADD CONSTRAINT cash_event_register_identity CHECK (money_event_version=0 OR
    (kind IN('PHYSICAL','VIRTUAL') AND operation_mode='INDIVIDUAL' AND currency_code IS NOT NULL));
-- Misma función de 2B.2; solo cambia el tipo de caja admitido al adoptar.
CREATE OR REPLACE FUNCTION protect_cash_event_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent record;
BEGIN
  IF TG_TABLE_NAME='cash_registers' THEN
    IF NEW.money_event_version<>OLD.money_event_version THEN
      IF OLD.money_event_version=1 OR NEW.kind NOT IN('PHYSICAL','VIRTUAL') OR NEW.operation_mode<>'INDIVIDUAL' OR NEW.currency_code IS NULL
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

-- Aviso de pago: «el cliente informó un pago». No es dinero: no toca cartera, anticipos, eventos ni asientos.
-- Al confirmarse enlaza el único cobro creado en un período abierto de caja virtual de la misma sucursal.
CREATE TABLE cash_payment_notices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,branch_id uuid NOT NULL,
 customer_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
 amount numeric(12,2) NOT NULL CHECK(amount>0 AND amount<=9999999999.99),currency_code varchar(3) NOT NULL,
 payment_method_id integer NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,
 reported_paid_on date NOT NULL,reported_reference varchar(120),
 link_kind varchar(10) CHECK(link_kind IN('SALE','DOCUMENT','ENGAGEMENT')),link_id uuid,
 notes varchar(1000),created_by_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 request_key uuid NOT NULL,request_hash varchar(64) NOT NULL,created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 status varchar(10) NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','CONFIRMED','REJECTED')),
 customer_payment_id uuid UNIQUE REFERENCES customer_payments(id) ON DELETE RESTRICT,
 confirmed_by_id uuid REFERENCES users(id) ON DELETE RESTRICT,confirmed_at timestamptz(3),paid_on date,
 external_reference varchar(120),verification_id varchar(120),evidence_path varchar(300),attested boolean,
 cash_register_session_id uuid REFERENCES cash_register_sessions(id) ON DELETE RESTRICT,
 rejected_by_id uuid REFERENCES users(id) ON DELETE RESTRICT,rejected_at timestamptz(3),rejection_reason varchar(1000),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id) ON DELETE RESTRICT,
 UNIQUE(company_id,branch_id,created_by_id,request_key),
 CHECK((link_kind IS NULL)=(link_id IS NULL)),
 -- Evidencia: identificador verificable o archivo privado de la propia empresa.
 CHECK(evidence_path IS NULL OR evidence_path LIKE company_id::text||'/notices/%'),
 CONSTRAINT cash_payment_notice_resolution CHECK(
  status='PENDING' AND num_nonnulls(customer_payment_id,confirmed_by_id,confirmed_at,paid_on,external_reference,verification_id,evidence_path,attested,cash_register_session_id,rejected_by_id,rejected_at,rejection_reason)=0
  OR status='CONFIRMED' AND num_nonnulls(customer_payment_id,confirmed_by_id,confirmed_at,paid_on,cash_register_session_id)=5 AND length(btrim(coalesce(external_reference,'')))>0
   AND attested AND (length(btrim(coalesce(verification_id,'')))>0 OR evidence_path IS NOT NULL) AND num_nonnulls(rejected_by_id,rejected_at,rejection_reason)=0
  OR status='REJECTED' AND rejected_by_id IS NOT NULL AND rejected_at IS NOT NULL AND length(btrim(coalesce(rejection_reason,'')))>0
   AND num_nonnulls(customer_payment_id,confirmed_by_id,confirmed_at,paid_on,external_reference,verification_id,evidence_path,attested,cash_register_session_id)=0)
);
CREATE INDEX cash_payment_notices_queue ON cash_payment_notices(company_id,branch_id,status,created_at DESC);

CREATE FUNCTION protect_cash_payment_notice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pay record; period record;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'cash_notice_state' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'PENDING' THEN RAISE EXCEPTION 'cash_notice_state' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_methods pm JOIN company_payment_methods cp ON cp.payment_method_id=pm.id AND cp.company_id=NEW.company_id AND cp.enabled
    WHERE pm.id=NEW.payment_method_id AND pm.settlement_kind='BANK' AND NOT pm.is_credit AND (pm.company_id IS NULL OR pm.company_id=NEW.company_id)) THEN
   RAISE EXCEPTION 'cash_notice_method' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM suppliers WHERE id=NEW.customer_id AND company_id=NEW.company_id)
   OR NEW.currency_code IS DISTINCT FROM (SELECT value FROM system_settings WHERE company_id=NEW.company_id AND key='currency_code') THEN
   RAISE EXCEPTION 'cash_notice_scope' USING ERRCODE='23514'; END IF;
  NEW.created_at=clock_timestamp();
  RETURN NEW;
 END IF;
 -- Solo PENDING→CONFIRMED|REJECTED; lo informado no cambia y lo resuelto es inmutable.
 IF OLD.status<>'PENDING' OR NEW.status='PENDING' OR (to_jsonb(NEW)-ARRAY['status','customer_payment_id','confirmed_by_id','confirmed_at','paid_on','external_reference','verification_id','evidence_path','attested','cash_register_session_id','rejected_by_id','rejected_at','rejection_reason'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','customer_payment_id','confirmed_by_id','confirmed_at','paid_on','external_reference','verification_id','evidence_path','attested','cash_register_session_id','rejected_by_id','rejected_at','rejection_reason']) THEN
  RAISE EXCEPTION 'cash_notice_state' USING ERRCODE='23514'; END IF;
 IF NEW.status='CONFIRMED' THEN
  NEW.confirmed_at=clock_timestamp();
  SELECT * INTO pay FROM customer_payments WHERE id=NEW.customer_payment_id;
  SELECT s.*,r.branch_id AS register_branch_id INTO period FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.cash_register_id WHERE s.id=NEW.cash_register_session_id;
  IF pay.id IS NULL OR period.id IS NULL OR pay.customer_id<>NEW.customer_id OR pay.amount<>NEW.amount OR pay.payment_method_id<>NEW.payment_method_id
   OR pay.branch_id<>NEW.branch_id OR pay.cash_register_session_id IS DISTINCT FROM NEW.cash_register_session_id
   OR period.register_type<>'VIRTUAL' OR period.status<>'OPEN' OR period.money_event_version<>1 OR period.register_branch_id<>NEW.branch_id THEN
   RAISE EXCEPTION 'cash_notice_payment' USING ERRCODE='23514'; END IF;
 ELSE
  NEW.rejected_at=clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_payment_notice BEFORE INSERT OR UPDATE OR DELETE ON cash_payment_notices FOR EACH ROW EXECUTE FUNCTION protect_cash_payment_notice();

DO $$ DECLARE client_role text; BEGIN
 REVOKE ALL ON TABLE cash_payment_notices FROM PUBLIC;
 FOREACH client_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN EXECUTE format('REVOKE ALL ON TABLE cash_payment_notices FROM %I',client_role); END IF;
 END LOOP;
END $$;
