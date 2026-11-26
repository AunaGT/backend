CREATE TABLE cash_physical_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,
 cash_register_id uuid NOT NULL,cash_register_session_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 request_key uuid NOT NULL,request_hash varchar(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 direction varchar(3) NOT NULL CHECK(direction IN('IN','OUT')),
 amount numeric(12,2) NOT NULL CHECK(amount>0 AND amount<=9999999999.99),
 payment_method_id integer NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,payment_method_name varchar(100) NOT NULL,
 currency_code varchar(3) NOT NULL CHECK(currency_code ~ '^[A-Z]{3}$'),
 economic_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 reason varchar(500) NOT NULL CHECK(length(btrim(reason))>0),counterparty_label varchar(120) NOT NULL CHECK(length(btrim(counterparty_label))>0),reference varchar(255),
 corrects_movement_id uuid UNIQUE REFERENCES cash_physical_movements(id) ON DELETE RESTRICT,
 UNIQUE(company_id,branch_id,actor_id,request_key),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(branch_id,cash_register_id) REFERENCES cash_registers(branch_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(cash_register_id,cash_register_session_id) REFERENCES cash_register_sessions(cash_register_id,id) ON DELETE RESTRICT
);
CREATE INDEX cash_physical_movements_scope_date ON cash_physical_movements(company_id,branch_id,created_at,id);
CREATE INDEX cash_physical_movements_session ON cash_physical_movements(cash_register_session_id);
ALTER TABLE cash_money_events ADD COLUMN physical_movement_id uuid REFERENCES cash_physical_movements(id) ON DELETE RESTRICT;
ALTER TABLE cash_money_events DROP CONSTRAINT cash_money_events_source_type_check,
 DROP CONSTRAINT cash_money_event_single_source;
ALTER TABLE cash_money_events ADD CONSTRAINT cash_money_events_source_type_check CHECK(source_type IN('SALE','CUSTOMER_PAYMENT','CUSTOMER_PAYMENT_REFUND','RETURN_SETTLEMENT','SUPPLIER_PAYMENT','PHYSICAL_MOVEMENT')),
 ADD CONSTRAINT cash_money_event_single_source CHECK(num_nonnulls(sale_id,customer_payment_id,customer_payment_refund_id,return_settlement_id,supplier_payment_id,physical_movement_id)=1 AND
 source_id IS NOT DISTINCT FROM CASE source_type WHEN 'SALE' THEN sale_id WHEN 'CUSTOMER_PAYMENT' THEN customer_payment_id
 WHEN 'CUSTOMER_PAYMENT_REFUND' THEN customer_payment_refund_id WHEN 'RETURN_SETTLEMENT' THEN return_settlement_id WHEN 'SUPPLIER_PAYMENT' THEN supplier_payment_id WHEN 'PHYSICAL_MOVEMENT' THEN physical_movement_id END);

-- Preserve the audited five-source projection; extend it without rewriting its financial rules.
ALTER FUNCTION cash_money_source(text,uuid) RENAME TO cash_money_source_commercial_v1;
CREATE FUNCTION cash_money_source(source_type text,source_id uuid)
RETURNS TABLE(company_id uuid,branch_id uuid,session_id uuid,actor_id uuid,method_id integer,amount numeric,
 economic_at timestamptz,reference text,direction text,eligible boolean,currency_code text,valid_money boolean,valid_scope boolean)
LANGUAGE plpgsql STABLE AS $$ BEGIN
 IF source_type='PHYSICAL_MOVEMENT' THEN RETURN QUERY
  SELECT m.company_id,m.branch_id,m.cash_register_session_id,m.actor_id,m.payment_method_id,m.amount,
   m.economic_at,m.reference::text,m.direction::text,true,m.currency_code::text,true,
   b.company_id=m.company_id AND r.branch_id=m.branch_id
  FROM cash_physical_movements m JOIN cash_registers r ON r.id=m.cash_register_id JOIN branches b ON b.id=m.branch_id WHERE m.id=source_id;
 ELSE RETURN QUERY SELECT * FROM cash_money_source_commercial_v1(source_type,source_id);
 END IF;
END $$;

CREATE FUNCTION protect_cash_physical_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE turn record; method record; original record; available numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'cash_physical_immutable' USING ERRCODE='23514'; END IF;
 SELECT s.*,r.branch_id,r.active,b.company_id INTO turn FROM cash_register_sessions s
  JOIN cash_registers r ON r.id=s.cash_register_id JOIN branches b ON b.id=r.branch_id WHERE s.id=NEW.cash_register_session_id FOR UPDATE OF s;
 IF turn.id IS NULL OR turn.status<>'OPEN' OR turn.money_event_version<>1 OR NOT turn.active
  OR turn.register_type<>'PHYSICAL' OR turn.operation_mode<>'INDIVIDUAL'
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
CREATE TRIGGER protect_cash_physical_movement BEFORE INSERT OR UPDATE OR DELETE ON cash_physical_movements
 FOR EACH ROW EXECUTE FUNCTION protect_cash_physical_movement();
CREATE FUNCTION require_cash_physical_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM cash_money_events WHERE source_type='PHYSICAL_MOVEMENT' AND source_id=NEW.id AND physical_movement_id=NEW.id) THEN
  RAISE EXCEPTION 'cash_physical_event_required' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER require_cash_physical_event AFTER INSERT ON cash_physical_movements
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cash_physical_event();
REVOKE ALL ON TABLE cash_physical_movements FROM PUBLIC;
DO $$ DECLARE client_role text; BEGIN
 FOREACH client_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN EXECUTE format('REVOKE ALL ON TABLE cash_physical_movements FROM %I',client_role); END IF;
 END LOOP;
END $$;
