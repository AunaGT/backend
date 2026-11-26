-- Cajas 3B.2: custodias, traslados bilaterales, entrega de turno y fondo retenido.
-- Dos libros que no se mezclan: durante un turno OPEN el efectivo vive en cash_money_events;
-- fuera de turno vive en cash_custody_entries (custodias y fondo retenido de cada caja).
CREATE TABLE cash_custodies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,
 name varchar(120) NOT NULL CHECK(length(btrim(name))>0),currency_code varchar(3) NOT NULL CHECK(currency_code ~ '^[A-Z]{3}$'),
 active boolean NOT NULL DEFAULT true,created_by_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(branch_id,id),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX cash_custodies_branch_name ON cash_custodies(branch_id,lower(btrim(name)));

CREATE TABLE cash_turn_handovers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,
 cash_register_id uuid NOT NULL,cash_register_session_id uuid NOT NULL UNIQUE,actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 request_key uuid NOT NULL,request_hash varchar(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 delivered_amount numeric(12,2) NOT NULL CHECK(delivered_amount>=0 AND delivered_amount<=9999999999.99),
 retained_amount numeric(12,2) NOT NULL CHECK(retained_amount>=0 AND retained_amount<=9999999999.99),
 expected_cash numeric(12,2),currency_code varchar(3) NOT NULL CHECK(currency_code ~ '^[A-Z]{3}$'),
 destination_custody_id uuid,notes varchar(500),created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 CHECK((delivered_amount>0)=(destination_custody_id IS NOT NULL)),
 UNIQUE(company_id,branch_id,actor_id,request_key),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(branch_id,cash_register_id) REFERENCES cash_registers(branch_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(cash_register_id,cash_register_session_id) REFERENCES cash_register_sessions(cash_register_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(branch_id,destination_custody_id) REFERENCES cash_custodies(branch_id,id) ON DELETE RESTRICT
);

CREATE TABLE cash_custody_transfers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,
 sender_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,request_key uuid NOT NULL,request_hash varchar(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 origin_kind varchar(10) NOT NULL CHECK(origin_kind IN('SESSION','CUSTODY','FLOAT','HANDOVER','RETURN')),
 origin_custody_id uuid,origin_register_id uuid,origin_session_id uuid,
 destination_kind varchar(10) NOT NULL CHECK(destination_kind IN('CUSTODY','REGISTER')),
 destination_custody_id uuid,destination_register_id uuid,
 amount numeric(12,2) NOT NULL CHECK(amount>0 AND amount<=9999999999.99),currency_code varchar(3) NOT NULL CHECK(currency_code ~ '^[A-Z]{3}$'),
 reason varchar(500) NOT NULL CHECK(length(btrim(reason))>0),reference varchar(255),
 status varchar(10) NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','RECEIVED','REJECTED')),
 received_amount numeric(12,2) CHECK(received_amount>=0 AND received_amount<=9999999999.99),
 receiver_id uuid REFERENCES users(id) ON DELETE RESTRICT,received_at timestamptz(3),receipt_reason varchar(500),
 returns_transfer_id uuid UNIQUE REFERENCES cash_custody_transfers(id) ON DELETE RESTRICT,
 handover_id uuid UNIQUE REFERENCES cash_turn_handovers(id) ON DELETE RESTRICT,
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,branch_id,sender_id,request_key),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(branch_id,origin_custody_id) REFERENCES cash_custodies(branch_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(branch_id,origin_register_id) REFERENCES cash_registers(branch_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(origin_register_id,origin_session_id) REFERENCES cash_register_sessions(cash_register_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(branch_id,destination_custody_id) REFERENCES cash_custodies(branch_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(branch_id,destination_register_id) REFERENCES cash_registers(branch_id,id) ON DELETE RESTRICT,
 CHECK(CASE origin_kind
  WHEN 'SESSION' THEN origin_session_id IS NOT NULL AND origin_register_id IS NOT NULL AND origin_custody_id IS NULL AND handover_id IS NULL
  WHEN 'CUSTODY' THEN origin_custody_id IS NOT NULL AND origin_register_id IS NULL AND origin_session_id IS NULL AND handover_id IS NULL
  WHEN 'FLOAT' THEN origin_register_id IS NOT NULL AND origin_session_id IS NULL AND origin_custody_id IS NULL AND handover_id IS NULL
  WHEN 'HANDOVER' THEN origin_session_id IS NOT NULL AND origin_register_id IS NOT NULL AND origin_custody_id IS NULL AND handover_id IS NOT NULL
  ELSE origin_custody_id IS NULL AND origin_register_id IS NULL AND origin_session_id IS NULL AND handover_id IS NULL END),
 CHECK((origin_kind='RETURN')=(returns_transfer_id IS NOT NULL)),
 CHECK(CASE destination_kind WHEN 'CUSTODY' THEN destination_custody_id IS NOT NULL AND destination_register_id IS NULL
  ELSE destination_register_id IS NOT NULL AND destination_custody_id IS NULL END),
 CHECK(CASE status WHEN 'PENDING' THEN received_amount IS NULL AND receiver_id IS NULL AND received_at IS NULL AND receipt_reason IS NULL
  WHEN 'RECEIVED' THEN received_amount IS NOT NULL AND receiver_id IS NOT NULL AND received_at IS NOT NULL
   AND (received_amount=amount OR length(btrim(coalesce(receipt_reason,'')))>0)
  ELSE received_amount IS NULL AND receiver_id IS NOT NULL AND received_at IS NOT NULL AND length(btrim(coalesce(receipt_reason,'')))>0 END),
 CHECK(receiver_id IS NULL OR receiver_id<>sender_id)
);
CREATE INDEX cash_custody_transfers_scope ON cash_custody_transfers(company_id,branch_id,status,created_at,id);

CREATE TABLE cash_custody_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,
 holder_kind varchar(8) NOT NULL CHECK(holder_kind IN('CUSTODY','FLOAT','SESSION')),
 custody_id uuid,cash_register_id uuid,cash_register_session_id uuid,
 direction varchar(3) NOT NULL CHECK(direction IN('IN','OUT')),
 amount numeric(12,2) NOT NULL CHECK(amount>0 AND amount<=9999999999.99),currency_code varchar(3) NOT NULL CHECK(currency_code ~ '^[A-Z]{3}$'),
 actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 payment_method_id integer REFERENCES payment_methods(id) ON DELETE RESTRICT,payment_method_name varchar(100),
 leg varchar(8) NOT NULL CHECK(leg IN('SEND','RECEIVE','RETAIN','OPENING')),
 transfer_id uuid REFERENCES cash_custody_transfers(id) ON DELETE RESTRICT,
 handover_id uuid UNIQUE REFERENCES cash_turn_handovers(id) ON DELETE RESTRICT,
 opening_session_id uuid UNIQUE REFERENCES cash_register_sessions(id) ON DELETE RESTRICT,
 economic_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(transfer_id,leg),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(branch_id,custody_id) REFERENCES cash_custodies(branch_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(branch_id,cash_register_id) REFERENCES cash_registers(branch_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(cash_register_id,cash_register_session_id) REFERENCES cash_register_sessions(cash_register_id,id) ON DELETE RESTRICT,
 CHECK(CASE holder_kind WHEN 'CUSTODY' THEN custody_id IS NOT NULL AND cash_register_id IS NULL AND cash_register_session_id IS NULL
  WHEN 'FLOAT' THEN custody_id IS NULL AND cash_register_id IS NOT NULL AND cash_register_session_id IS NULL
  ELSE custody_id IS NULL AND cash_register_id IS NOT NULL AND cash_register_session_id IS NOT NULL END),
 CHECK((holder_kind='SESSION')=(payment_method_id IS NOT NULL AND payment_method_name IS NOT NULL)),
 CHECK(CASE leg WHEN 'SEND' THEN direction='OUT' AND transfer_id IS NOT NULL AND handover_id IS NULL AND opening_session_id IS NULL
  WHEN 'RECEIVE' THEN direction='IN' AND transfer_id IS NOT NULL AND handover_id IS NULL AND opening_session_id IS NULL
  WHEN 'RETAIN' THEN direction='IN' AND holder_kind='FLOAT' AND handover_id IS NOT NULL AND transfer_id IS NULL AND opening_session_id IS NULL
  ELSE direction='OUT' AND holder_kind='FLOAT' AND opening_session_id IS NOT NULL AND transfer_id IS NULL AND handover_id IS NULL END)
);
CREATE INDEX cash_custody_entries_custody ON cash_custody_entries(custody_id) WHERE custody_id IS NOT NULL;
CREATE INDEX cash_custody_entries_float ON cash_custody_entries(cash_register_id) WHERE holder_kind='FLOAT';

ALTER TABLE cash_register_sessions ADD COLUMN opening_inherited_amount numeric(12,2) CHECK(opening_inherited_amount>0);

ALTER TABLE cash_money_events ADD COLUMN custody_entry_id uuid REFERENCES cash_custody_entries(id) ON DELETE RESTRICT;
ALTER TABLE cash_money_events DROP CONSTRAINT cash_money_events_source_type_check,DROP CONSTRAINT cash_money_event_single_source;
ALTER TABLE cash_money_events ADD CONSTRAINT cash_money_events_source_type_check CHECK(source_type IN('SALE','CUSTOMER_PAYMENT','CUSTOMER_PAYMENT_REFUND','RETURN_SETTLEMENT','SUPPLIER_PAYMENT','PHYSICAL_MOVEMENT','CUSTODY_ENTRY')),
 ADD CONSTRAINT cash_money_event_single_source CHECK(num_nonnulls(sale_id,customer_payment_id,customer_payment_refund_id,return_settlement_id,supplier_payment_id,physical_movement_id,custody_entry_id)=1 AND
 source_id IS NOT DISTINCT FROM CASE source_type WHEN 'SALE' THEN sale_id WHEN 'CUSTOMER_PAYMENT' THEN customer_payment_id
 WHEN 'CUSTOMER_PAYMENT_REFUND' THEN customer_payment_refund_id WHEN 'RETURN_SETTLEMENT' THEN return_settlement_id WHEN 'SUPPLIER_PAYMENT' THEN supplier_payment_id
 WHEN 'PHYSICAL_MOVEMENT' THEN physical_movement_id WHEN 'CUSTODY_ENTRY' THEN custody_entry_id END);

-- Se extiende la proyección auditada sin reescribir sus reglas anteriores.
ALTER FUNCTION cash_money_source(text,uuid) RENAME TO cash_money_source_physical_v1;
CREATE FUNCTION cash_money_source(source_type text,source_id uuid)
RETURNS TABLE(company_id uuid,branch_id uuid,session_id uuid,actor_id uuid,method_id integer,amount numeric,
 economic_at timestamptz,reference text,direction text,eligible boolean,currency_code text,valid_money boolean,valid_scope boolean)
LANGUAGE plpgsql STABLE AS $$ BEGIN
 IF source_type='CUSTODY_ENTRY' THEN RETURN QUERY
  SELECT e.company_id,e.branch_id,e.cash_register_session_id,e.actor_id,e.payment_method_id,e.amount,
   e.economic_at,NULL::text,e.direction::text,e.holder_kind='SESSION',e.currency_code::text,true,
   b.company_id=e.company_id AND r.branch_id=e.branch_id
  FROM cash_custody_entries e JOIN cash_registers r ON r.id=e.cash_register_id JOIN branches b ON b.id=e.branch_id WHERE e.id=source_id;
 ELSE RETURN QUERY SELECT * FROM cash_money_source_physical_v1(source_type,source_id);
 END IF;
END $$;

-- Saldo de un titular fuera de turno (custodia o fondo retenido de una caja).
CREATE FUNCTION cash_custody_balance(p_custody uuid,p_register uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT coalesce(sum(CASE direction WHEN 'IN' THEN amount ELSE -amount END),0) FROM cash_custody_entries
 WHERE (p_custody IS NOT NULL AND custody_id=p_custody) OR (p_custody IS NULL AND holder_kind='FLOAT' AND cash_register_id=p_register)
$$;

CREATE FUNCTION protect_cash_custody_entry() RETURNS trigger LANGUAGE plpgsql AS $$
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
   OR holder.kind<>'PHYSICAL' OR holder.operation_mode<>'INDIVIDUAL' OR holder.currency_code IS DISTINCT FROM NEW.currency_code
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
CREATE TRIGGER protect_cash_custody_entry BEFORE INSERT OR UPDATE OR DELETE ON cash_custody_entries FOR EACH ROW EXECUTE FUNCTION protect_cash_custody_entry();

-- Un asiento dentro de un turno abierto existe solo junto con su evento del libro.
CREATE FUNCTION require_cash_custody_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.holder_kind='SESSION')<>EXISTS(SELECT 1 FROM cash_money_events WHERE source_type='CUSTODY_ENTRY' AND source_id=NEW.id AND custody_entry_id=NEW.id) THEN
  RAISE EXCEPTION 'cash_custody_event_required' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER require_cash_custody_event AFTER INSERT ON cash_custody_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cash_custody_event();

CREATE FUNCTION protect_cash_custody_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NOT holder.active OR holder.money_event_version<>1 OR holder.kind<>'PHYSICAL' OR holder.operation_mode<>'INDIVIDUAL'
   OR holder.currency_code IS DISTINCT FROM NEW.currency_code OR NEW.origin_kind IN('SESSION','FLOAT') AND NEW.destination_register_id=NEW.origin_register_id THEN
   RAISE EXCEPTION 'cash_custody_destination' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_custody_transfer BEFORE INSERT OR UPDATE OR DELETE ON cash_custody_transfers FOR EACH ROW EXECUTE FUNCTION protect_cash_custody_transfer();

-- Coherencia del documento con su libro, comprobada al confirmar la transacción.
CREATE FUNCTION require_cash_custody_transfer_legs() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record; sent numeric; received numeric;
BEGIN
 SELECT * INTO t FROM cash_custody_transfers WHERE id=NEW.id;
 SELECT sum(amount) FILTER (WHERE leg='SEND'),sum(amount) FILTER (WHERE leg='RECEIVE') INTO sent,received FROM cash_custody_entries WHERE transfer_id=t.id;
 IF ((CASE WHEN t.origin_kind IN('SESSION','CUSTODY','FLOAT') THEN sent IS DISTINCT FROM t.amount ELSE sent IS NOT NULL END)
  OR EXISTS(SELECT 1 FROM cash_custody_entries e WHERE e.transfer_id=t.id AND NOT CASE e.leg
   WHEN 'SEND' THEN CASE t.origin_kind WHEN 'CUSTODY' THEN e.custody_id=t.origin_custody_id
    WHEN 'SESSION' THEN e.cash_register_session_id=t.origin_session_id ELSE e.holder_kind='FLOAT' AND e.cash_register_id=t.origin_register_id END
   ELSE CASE t.destination_kind WHEN 'CUSTODY' THEN e.custody_id IS NOT DISTINCT FROM t.destination_custody_id
    ELSE e.holder_kind IN('FLOAT','SESSION') AND e.cash_register_id=t.destination_register_id END END)
  OR t.status='RECEIVED' AND received IS DISTINCT FROM CASE WHEN t.received_amount>0 THEN t.received_amount END
  OR t.status<>'RECEIVED' AND received IS NOT NULL
  OR t.status='REJECTED' AND NOT EXISTS(SELECT 1 FROM cash_custody_transfers r WHERE r.returns_transfer_id=t.id AND r.amount=t.amount AND r.status='PENDING')
  OR t.origin_kind='HANDOVER' AND NOT EXISTS(SELECT 1 FROM cash_turn_handovers h WHERE h.id=t.handover_id AND h.delivered_amount=t.amount AND h.destination_custody_id IS NOT DISTINCT FROM t.destination_custody_id)) THEN
  RAISE EXCEPTION 'cash_custody_transfer_legs' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER require_cash_custody_transfer_legs AFTER INSERT OR UPDATE ON cash_custody_transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cash_custody_transfer_legs();

CREATE FUNCTION protect_cash_turn_handover() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE turn record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'cash_custody_immutable' USING ERRCODE='23514'; END IF;
 SELECT s.*,r.branch_id,b.company_id INTO turn FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.cash_register_id
  JOIN branches b ON b.id=r.branch_id WHERE s.id=NEW.cash_register_session_id FOR UPDATE OF s;
 IF turn.id IS NULL OR turn.status<>'CLOSED' OR turn.money_event_version<>1 OR turn.register_type<>'PHYSICAL' OR turn.operation_mode<>'INDIVIDUAL'
  OR (turn.company_id,turn.branch_id,turn.cash_register_id,turn.currency_code) IS DISTINCT FROM (NEW.company_id,NEW.branch_id,NEW.cash_register_id,NEW.currency_code) THEN
  RAISE EXCEPTION 'cash_custody_handover_turn' USING ERRCODE='23514'; END IF;
 NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_turn_handover BEFORE INSERT OR UPDATE OR DELETE ON cash_turn_handovers FOR EACH ROW EXECUTE FUNCTION protect_cash_turn_handover();
CREATE FUNCTION require_cash_turn_handover_parts() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.retained_amount>0)<>EXISTS(SELECT 1 FROM cash_custody_entries WHERE handover_id=NEW.id AND leg='RETAIN' AND amount=NEW.retained_amount AND cash_register_id=NEW.cash_register_id)
  OR (NEW.delivered_amount>0)<>EXISTS(SELECT 1 FROM cash_custody_transfers WHERE handover_id=NEW.id) THEN
  RAISE EXCEPTION 'cash_custody_handover_parts' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER require_cash_turn_handover_parts AFTER INSERT ON cash_turn_handovers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cash_turn_handover_parts();

-- El fondo heredado se consume una sola vez y en la misma transacción que abre el turno.
CREATE FUNCTION require_cash_opening_consumption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.opening_inherited_amount IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cash_custody_entries WHERE opening_session_id=NEW.id AND amount=NEW.opening_inherited_amount AND cash_register_id=NEW.cash_register_id) THEN
  RAISE EXCEPTION 'cash_custody_opening' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION protect_cash_opening_inherited() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.opening_inherited_amount IS NOT NULL THEN RAISE EXCEPTION 'cash_custody_opening' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_opening_inherited BEFORE UPDATE OF opening_inherited_amount ON cash_register_sessions FOR EACH ROW EXECUTE FUNCTION protect_cash_opening_inherited();
CREATE CONSTRAINT TRIGGER require_cash_opening_consumption AFTER INSERT OR UPDATE OF opening_inherited_amount ON cash_register_sessions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cash_opening_consumption();

DO $$ DECLARE client_role text; t text; BEGIN
 FOREACH t IN ARRAY ARRAY['cash_custodies','cash_turn_handovers','cash_custody_transfers','cash_custody_entries'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',t);
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',t,client_role); END IF;
  END LOOP;
 END LOOP;
END $$;
