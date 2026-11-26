ALTER TABLE cash_registers ADD COLUMN money_event_version integer NOT NULL DEFAULT 0
  CHECK (money_event_version IN (0,1)),
  ADD CONSTRAINT cash_event_register_identity CHECK (money_event_version=0 OR
    (kind='PHYSICAL' AND operation_mode='INDIVIDUAL' AND currency_code IS NOT NULL));
ALTER TABLE cash_register_sessions ADD COLUMN money_event_version integer NOT NULL DEFAULT 0
  CHECK (money_event_version IN (0,1)), ADD COLUMN business_timezone varchar(100),
  ADD COLUMN opening_cash_method_id integer REFERENCES payment_methods(id) ON DELETE RESTRICT,
  ADD COLUMN opening_cash_method_name varchar(100),
  ADD CONSTRAINT cash_event_session_snapshot CHECK (money_event_version=0 OR
    (register_type IS NOT NULL AND operation_mode IS NOT NULL AND currency_code IS NOT NULL AND business_date IS NOT NULL AND business_timezone IS NOT NULL AND opening_float>=0 AND opening_float<=9999999999.99
      AND (opening_float=0 OR (opening_cash_method_id IS NOT NULL AND opening_cash_method_name IS NOT NULL))));
CREATE UNIQUE INDEX IF NOT EXISTS cash_session_register_identity_key ON cash_register_sessions(cash_register_id,id);
ALTER TABLE supplier_payments ADD COLUMN cash_register_session_id uuid
  REFERENCES cash_register_sessions(id) ON DELETE RESTRICT;
CREATE INDEX supplier_payments_cash_register_session_id_idx ON supplier_payments(cash_register_session_id);
ALTER TABLE customer_payments ADD COLUMN request_key uuid, ADD COLUMN request_hash varchar(64),
  ADD CONSTRAINT customer_payment_request_pair CHECK ((request_key IS NULL AND request_hash IS NULL) OR
    (request_key IS NOT NULL AND request_hash IS NOT NULL AND request_hash ~ '^[a-f0-9]{64}$'));
CREATE UNIQUE INDEX customer_payment_request_key ON customer_payments(branch_id,registered_by,request_key);
ALTER TABLE cash_closures ADD COLUMN calculation_snapshot jsonb;

CREATE FUNCTION protect_cash_closure_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE frozen jsonb; parent_id uuid;
BEGIN
  IF TG_TABLE_NAME='cash_closures' THEN
    IF OLD.calculation_snapshot IS NOT NULL THEN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'cash_closure_snapshot_immutable' USING ERRCODE='23514'; END IF;
      IF NEW.calculation_snapshot IS DISTINCT FROM OLD.calculation_snapshot OR
        (NEW.branch_id,NEW.date,NEW.start_date,NEW.end_date,NEW.cashier_id,NEW.cashier_name,NEW.opening_float,
         NEW.theoretical_total,NEW.theoretical_sales,NEW.theoretical_returns,NEW.actual_total,NEW.difference,NEW.difference_percentage,
         NEW.total_transactions,NEW.total_customers,NEW.average_ticket)
        IS DISTINCT FROM
        (OLD.branch_id,OLD.date,OLD.start_date,OLD.end_date,OLD.cashier_id,OLD.cashier_name,OLD.opening_float,
         OLD.theoretical_total,OLD.theoretical_sales,OLD.theoretical_returns,OLD.actual_total,OLD.difference,OLD.difference_percentage,
         OLD.total_transactions,OLD.total_customers,OLD.average_ticket) THEN
        RAISE EXCEPTION 'cash_closure_snapshot_immutable' USING ERRCODE='23514';
      END IF;
    END IF;
  ELSE
    parent_id=CASE WHEN TG_OP='DELETE' THEN OLD.cash_closure_id ELSE NEW.cash_closure_id END;
    SELECT calculation_snapshot INTO frozen FROM cash_closures WHERE id=parent_id FOR UPDATE;
    IF frozen IS NOT NULL THEN RAISE EXCEPTION 'cash_closure_snapshot_immutable: declaration is frozen' USING ERRCODE='23514'; END IF;
    IF TG_OP='UPDATE' AND OLD.cash_closure_id IS DISTINCT FROM NEW.cash_closure_id AND EXISTS(
      SELECT 1 FROM cash_closures WHERE id=OLD.cash_closure_id AND calculation_snapshot IS NOT NULL) THEN
      RAISE EXCEPTION 'cash_closure_snapshot_immutable: declaration cannot be moved' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_closure_snapshot BEFORE UPDATE OR DELETE ON cash_closures FOR EACH ROW EXECUTE FUNCTION protect_cash_closure_snapshot();
CREATE TRIGGER protect_cash_closure_payment BEFORE INSERT OR UPDATE OR DELETE ON cash_closure_payments FOR EACH ROW EXECUTE FUNCTION protect_cash_closure_snapshot();
CREATE TRIGGER protect_cash_closure_denomination BEFORE INSERT OR UPDATE OR DELETE ON cash_closure_denominations FOR EACH ROW EXECUTE FUNCTION protect_cash_closure_snapshot();

CREATE TABLE cash_money_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL, cash_register_id uuid NOT NULL, cash_register_session_id uuid NOT NULL,
  source_type varchar(30) NOT NULL CHECK (source_type IN ('SALE','CUSTOMER_PAYMENT','CUSTOMER_PAYMENT_REFUND','RETURN_SETTLEMENT','SUPPLIER_PAYMENT')),
  source_id uuid NOT NULL, direction varchar(3) NOT NULL CHECK (direction IN ('IN','OUT')),
  amount numeric(12,2) NOT NULL CHECK (amount>0 AND amount<=9999999999.99), payment_method_id integer NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,
  payment_method_name varchar(100) NOT NULL, settlement_kind varchar(4) NOT NULL CHECK (settlement_kind IN ('CASH','BANK')),
  currency_code varchar(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'), actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  economic_at timestamptz(3) NOT NULL, recorded_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reference varchar(255), content_hash varchar(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  sale_id uuid REFERENCES sales(id) ON DELETE RESTRICT,
  customer_payment_id uuid REFERENCES customer_payments(id) ON DELETE RESTRICT,
  customer_payment_refund_id uuid REFERENCES customer_payment_refunds(id) ON DELETE RESTRICT,
  return_settlement_id uuid REFERENCES return_settlements(id) ON DELETE RESTRICT,
  supplier_payment_id uuid REFERENCES supplier_payments(id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id,branch_id) REFERENCES branches(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (branch_id,cash_register_id) REFERENCES cash_registers(branch_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (cash_register_id,cash_register_session_id) REFERENCES cash_register_sessions(cash_register_id,id) ON DELETE RESTRICT,
  CONSTRAINT cash_money_event_origin_key UNIQUE(source_type,source_id),
  CONSTRAINT cash_money_event_single_source CHECK (num_nonnulls(sale_id,customer_payment_id,customer_payment_refund_id,return_settlement_id,supplier_payment_id)=1 AND
    source_id IS NOT DISTINCT FROM CASE source_type WHEN 'SALE' THEN sale_id WHEN 'CUSTOMER_PAYMENT' THEN customer_payment_id
      WHEN 'CUSTOMER_PAYMENT_REFUND' THEN customer_payment_refund_id WHEN 'RETURN_SETTLEMENT' THEN return_settlement_id WHEN 'SUPPLIER_PAYMENT' THEN supplier_payment_id END)
);
CREATE INDEX cash_money_events_company_id_branch_id_recorded_at_idx ON cash_money_events(company_id,branch_id,recorded_at);
CREATE INDEX cash_money_events_cash_register_session_id_recorded_at_idx ON cash_money_events(cash_register_session_id,recorded_at);

CREATE FUNCTION protect_cash_event_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent record;
BEGIN
  IF TG_TABLE_NAME='cash_registers' THEN
    IF NEW.money_event_version<>OLD.money_event_version THEN
      IF OLD.money_event_version=1 OR NEW.kind<>'PHYSICAL' OR NEW.operation_mode<>'INDIVIDUAL' OR NEW.currency_code IS NULL
        OR EXISTS(SELECT 1 FROM cash_register_sessions WHERE cash_register_id=OLD.id AND status='OPEN') THEN
        RAISE EXCEPTION 'cash_event_register: adoption requires a configured individual physical box without an open turn; cannot downgrade' USING ERRCODE='23514';
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
CREATE TRIGGER protect_cash_event_register BEFORE UPDATE OF money_event_version ON cash_registers FOR EACH ROW EXECUTE FUNCTION protect_cash_event_version();
CREATE TRIGGER protect_cash_event_session BEFORE INSERT OR UPDATE OF money_event_version,business_timezone,opening_cash_method_id,opening_cash_method_name,opened_at,opened_by_id ON cash_register_sessions FOR EACH ROW EXECUTE FUNCTION protect_cash_event_version();

-- One canonical projection is shared by the writer and deferred integrity checks.
CREATE FUNCTION cash_money_source(source_type text, source_id uuid)
RETURNS TABLE(company_id uuid,branch_id uuid,session_id uuid,actor_id uuid,method_id integer,amount numeric,
  economic_at timestamptz,reference text,direction text,eligible boolean,currency_code text,valid_money boolean,valid_scope boolean)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  CASE source_type
  WHEN 'SALE' THEN RETURN QUERY
    SELECT b.company_id,s.branch_id,s.cash_register_session_id,s.created_by,s.payment_method_id,s.total,
      s.sold_at AT TIME ZONE 'UTC',s.reference::text,'IN'::text,
      st.name='Completada' AND s.settlement_source='LEGACY' AND NOT coalesce(pm.is_credit,false)
        AND NOT EXISTS(SELECT 1 FROM returns r WHERE r.replacement_sale_id=s.id), NULL::text,
      s.amount_received IS NULL OR s.change IS NULL OR s.amount_received-s.change=s.total,
      s.customer_contact_id IS NULL OR EXISTS(SELECT 1 FROM suppliers c WHERE c.id=s.customer_contact_id AND c.company_id=b.company_id)
    FROM sales s JOIN branches b ON b.id=s.branch_id JOIN sale_statuses st ON st.id=s.status_id
      LEFT JOIN payment_methods pm ON pm.id=s.payment_method_id WHERE s.id=source_id;
  WHEN 'CUSTOMER_PAYMENT' THEN RETURN QUERY
    SELECT b.company_id,p.branch_id,p.cash_register_session_id,p.registered_by,p.payment_method_id,p.amount,
      p.paid_at AT TIME ZONE 'UTC',p.reference::text,'IN'::text,p.kind='PAYMENT',NULL::text,true,
      EXISTS(SELECT 1 FROM suppliers c WHERE c.id=p.customer_id AND c.company_id=b.company_id)
    FROM customer_payments p JOIN branches b ON b.id=p.branch_id WHERE p.id=source_id;
  WHEN 'CUSTOMER_PAYMENT_REFUND' THEN RETURN QUERY
    SELECT p.company_id,p.branch_id,p.cash_register_session_id,p.registered_by,p.payment_method_id,p.amount,
      p.confirmed_at AT TIME ZONE 'UTC',p.reference::text,'OUT'::text,p.status='CONFIRMED',NULL::text,true,
      b.company_id=p.company_id
    FROM customer_payment_refunds p JOIN branches b ON b.id=p.branch_id WHERE p.id=source_id;
  WHEN 'RETURN_SETTLEMENT' THEN RETURN QUERY
    SELECT b.company_id,s.branch_id,p.cash_register_session_id,p.registered_by,p.payment_method_id,p.amount,
      p.created_at AT TIME ZONE 'UTC',p.external_reference::text,CASE WHEN p.kind='COLLECTION' THEN 'IN' ELSE 'OUT' END,
      p.kind IN ('REFUND','COLLECTION'),NULL::text,true,true
    FROM return_settlements p JOIN returns r ON r.id=p.return_id JOIN sales s ON s.id=r.sale_id JOIN branches b ON b.id=s.branch_id WHERE p.id=source_id;
  WHEN 'SUPPLIER_PAYMENT' THEN RETURN QUERY
    SELECT p.company_id,p.branch_id,p.cash_register_session_id,p.registered_by,p.payment_method_id,p.amount,
      p.paid_at AT TIME ZONE 'UTC',p.reference::text,'OUT'::text,p.status='POSTED',p.currency_code::text,true,
      b.company_id=p.company_id AND EXISTS(SELECT 1 FROM suppliers c WHERE c.id=p.supplier_id AND c.company_id=p.company_id)
    FROM supplier_payments p JOIN branches b ON b.id=p.branch_id WHERE p.id=source_id;
  ELSE RETURN;
  END CASE;
END $$;

CREATE FUNCTION validate_cash_money_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record; session_row record; method record;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'cash_event_immutable: corrections require a new authorized document' USING ERRCODE='23514'; END IF;
  SELECT * INTO source FROM cash_money_source(NEW.source_type,NEW.source_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'cash_event_source_missing' USING ERRCODE='23514'; END IF;
  SELECT s.*,r.branch_id,b.company_id,r.active FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.cash_register_id
    JOIN branches b ON b.id=r.branch_id WHERE s.id=NEW.cash_register_session_id FOR UPDATE OF s INTO session_row;
  SELECT pm.* INTO method FROM payment_methods pm JOIN company_payment_methods cp ON cp.payment_method_id=pm.id
    WHERE pm.id=NEW.payment_method_id AND cp.company_id=NEW.company_id AND cp.enabled;
  IF session_row.id IS NULL OR session_row.money_event_version<>1 OR session_row.status<>'OPEN' OR NOT session_row.active
    OR NOT source.eligible OR NOT source.valid_money OR NOT source.valid_scope
    OR (source.company_id,source.branch_id,source.session_id,source.actor_id,source.method_id,source.amount,source.economic_at,source.direction)
       IS DISTINCT FROM (NEW.company_id,NEW.branch_id,NEW.cash_register_session_id,NEW.actor_id,NEW.payment_method_id,NEW.amount,NEW.economic_at,NEW.direction)
    OR (session_row.company_id,session_row.branch_id,session_row.cash_register_id,session_row.currency_code)
       IS DISTINCT FROM (NEW.company_id,NEW.branch_id,NEW.cash_register_id,NEW.currency_code)
    OR method.id IS NULL OR method.is_credit OR method.company_id IS NOT NULL AND method.company_id<>NEW.company_id
    OR method.settlement_kind::text IS DISTINCT FROM NEW.settlement_kind OR method.name IS DISTINCT FROM NEW.payment_method_name
    OR source.currency_code IS NOT NULL AND source.currency_code<>NEW.currency_code
    OR NOT EXISTS(SELECT 1 FROM system_settings WHERE company_id=NEW.company_id AND key='currency_code' AND value=NEW.currency_code)
    OR session_row.register_type='VIRTUAL' AND NEW.settlement_kind<>'BANK' THEN
    RAISE EXCEPTION 'cash_event_source_mismatch: scope, money, method or turn differs from persisted source' USING ERRCODE='23514';
  END IF;
  NEW.recorded_at=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER validate_cash_money_event BEFORE INSERT OR UPDATE OR DELETE ON cash_money_events FOR EACH ROW EXECUTE FUNCTION validate_cash_money_event();

CREATE FUNCTION require_cash_money_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; source record; event cash_money_events%ROWTYPE; version integer;
BEGIN
  kind=CASE TG_TABLE_NAME WHEN 'sales' THEN 'SALE' WHEN 'customer_payments' THEN 'CUSTOMER_PAYMENT'
    WHEN 'customer_payment_refunds' THEN 'CUSTOMER_PAYMENT_REFUND' WHEN 'return_settlements' THEN 'RETURN_SETTLEMENT' WHEN 'supplier_payments' THEN 'SUPPLIER_PAYMENT' END;
  SELECT * INTO source FROM cash_money_source(kind,NEW.id);
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO event FROM cash_money_events WHERE source_type=kind AND source_id=NEW.id;
  IF FOUND THEN
    IF NOT source.valid_scope OR NOT source.valid_money OR source.currency_code IS NOT NULL AND source.currency_code<>event.currency_code OR
      (source.company_id,source.branch_id,source.session_id,source.actor_id,source.method_id,source.amount,source.economic_at,source.direction)
      IS DISTINCT FROM (event.company_id,event.branch_id,event.cash_register_session_id,event.actor_id,event.payment_method_id,event.amount,event.economic_at,event.direction) THEN
      RAISE EXCEPTION 'cash_event_source_immutable: recorded money cannot be rewritten' USING ERRCODE='23514';
    END IF;
  ELSIF source.eligible AND source.amount<>0 THEN
    SELECT money_event_version INTO version FROM cash_register_sessions WHERE id=source.session_id;
    IF version=1 THEN RAISE EXCEPTION 'cash_event_required: source and canonical event must commit together' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER require_cash_money_event_sale AFTER INSERT OR UPDATE ON sales DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cash_money_event();
CREATE CONSTRAINT TRIGGER require_cash_money_event_receipt AFTER INSERT OR UPDATE ON customer_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cash_money_event();
CREATE CONSTRAINT TRIGGER require_cash_money_event_refund AFTER INSERT OR UPDATE ON customer_payment_refunds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cash_money_event();
CREATE CONSTRAINT TRIGGER require_cash_money_event_return AFTER INSERT OR UPDATE ON return_settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cash_money_event();
CREATE CONSTRAINT TRIGGER require_cash_money_event_supplier AFTER INSERT OR UPDATE ON supplier_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cash_money_event();
