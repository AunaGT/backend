-- Cajas 4B: medios bancarios DIRECT/DEFERRED con aprobación del admin, clasificación congelada por evento,
-- depósitos con distribución por sucursal, liquidaciones y ajuste de Cartera por contracargo.

-- Versiones de configuración: un gestor propone, solo el admin aprueba (lo comprueba el servidor); nadie edita la vigente.
CREATE TABLE cash_bank_method_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 payment_method_id integer NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,version integer NOT NULL CHECK(version>0),
 mode varchar(8) NOT NULL CHECK(mode IN('DIRECT','DEFERRED')),destination_label varchar(150) NOT NULL CHECK(length(btrim(destination_label))>0),
 bank_account_id integer REFERENCES accounts(id) ON DELETE RESTRICT,clearing_account_id integer REFERENCES accounts(id) ON DELETE RESTRICT,
 fee_account_id integer REFERENCES accounts(id) ON DELETE RESTRICT,base_version_id uuid REFERENCES cash_bank_method_versions(id) ON DELETE RESTRICT,
 status varchar(10) NOT NULL DEFAULT 'PROPOSED' CHECK(status IN('PROPOSED','APPROVED','REJECTED','WITHDRAWN','SUPERSEDED')),
 proposed_by_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,proposed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 decided_by_id uuid REFERENCES users(id) ON DELETE RESTRICT,decided_at timestamptz(3),decision_reason varchar(500),
 UNIQUE(company_id,payment_method_id,version),
 CHECK(mode='DEFERRED' OR clearing_account_id IS NULL AND fee_account_id IS NULL),
 CHECK(status IN('PROPOSED','WITHDRAWN') OR decided_by_id IS NOT NULL AND decided_at IS NOT NULL),
 CHECK(status<>'REJECTED' OR length(btrim(coalesce(decision_reason,'')))>0)
);
CREATE UNIQUE INDEX cash_bank_method_one_proposal ON cash_bank_method_versions(company_id,payment_method_id) WHERE status='PROPOSED';
CREATE TABLE cash_bank_method_settings (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,payment_method_id integer NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,
 active_version_id uuid NOT NULL UNIQUE REFERENCES cash_bank_method_versions(id) ON DELETE RESTRICT,updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,payment_method_id)
);

CREATE FUNCTION protect_cash_bank_method_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE acc record; active uuid;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'cash_bank_method_state' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'PROPOSED' THEN RAISE EXCEPTION 'cash_bank_method_state' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payment_methods pm JOIN company_payment_methods cp ON cp.payment_method_id=pm.id AND cp.company_id=NEW.company_id
    WHERE pm.id=NEW.payment_method_id AND pm.settlement_kind='BANK' AND NOT pm.is_credit AND (pm.company_id IS NULL OR pm.company_id=NEW.company_id)) THEN
   RAISE EXCEPTION 'cash_bank_method_kind' USING ERRCODE='23514'; END IF;
  -- Cuentas de la empresa, activas, de detalle y del tipo correcto: banco y transitoria activo, comisión gasto.
  FOR acc IN SELECT a.*,k.expected FROM (VALUES(NEW.bank_account_id,'ASSET'),(NEW.clearing_account_id,'ASSET'),(NEW.fee_account_id,'EXPENSE')) k(id,expected)
    JOIN accounts a ON a.id=k.id LOOP
   IF acc.company_id<>NEW.company_id OR NOT acc.active OR acc.is_group OR acc.type::text<>acc.expected THEN RAISE EXCEPTION 'cash_bank_method_account' USING ERRCODE='23514'; END IF;
  END LOOP;
  NEW.proposed_at=clock_timestamp(); NEW.decided_by_id=NULL; NEW.decided_at=NULL;
  RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['status','decided_by_id','decided_at','decision_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','decided_by_id','decided_at','decision_reason'])
  OR NOT (OLD.status='PROPOSED' AND NEW.status IN('APPROVED','REJECTED','WITHDRAWN') OR OLD.status='APPROVED' AND NEW.status='SUPERSEDED') THEN
  RAISE EXCEPTION 'cash_bank_method_state' USING ERRCODE='23514'; END IF;
 IF NEW.status='APPROVED' THEN
  SELECT active_version_id INTO active FROM cash_bank_method_settings WHERE company_id=NEW.company_id AND payment_method_id=NEW.payment_method_id FOR UPDATE;
  IF NEW.base_version_id IS DISTINCT FROM active THEN RAISE EXCEPTION 'cash_bank_method_stale' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.status IN('APPROVED','REJECTED') THEN NEW.decided_at=clock_timestamp(); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_bank_method_version BEFORE INSERT OR UPDATE OR DELETE ON cash_bank_method_versions FOR EACH ROW EXECUTE FUNCTION protect_cash_bank_method_version();

-- La versión vigente solo puede ser una aprobada del mismo medio.
CREATE FUNCTION require_cash_bank_method_setting() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'cash_bank_method_state' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM cash_bank_method_versions WHERE id=NEW.active_version_id AND company_id=NEW.company_id AND payment_method_id=NEW.payment_method_id AND status='APPROVED') THEN
  RAISE EXCEPTION 'cash_bank_method_state' USING ERRCODE='23514'; END IF;
 NEW.updated_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER require_cash_bank_method_setting BEFORE INSERT OR UPDATE OR DELETE ON cash_bank_method_settings FOR EACH ROW EXECUTE FUNCTION require_cash_bank_method_setting();

-- Clasificación congelada: la crea la BD al insertar un evento BANK de un medio con versión vigente. Inmutable.
CREATE TABLE cash_bank_event_modes (
 event_id uuid PRIMARY KEY REFERENCES cash_money_events(id) ON DELETE RESTRICT,
 version_id uuid NOT NULL REFERENCES cash_bank_method_versions(id) ON DELETE RESTRICT,
 mode varchar(8) NOT NULL CHECK(mode IN('DIRECT','DEFERRED')),account_id integer REFERENCES accounts(id) ON DELETE RESTRICT,
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION protect_cash_bank_event_mode() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM cash_money_events e JOIN cash_bank_method_settings s ON s.company_id=e.company_id AND s.payment_method_id=e.payment_method_id
   JOIN cash_bank_method_versions v ON v.id=s.active_version_id
   WHERE e.id=NEW.event_id AND e.settlement_kind='BANK' AND v.id=NEW.version_id AND v.mode=NEW.mode
   AND NEW.account_id IS NOT DISTINCT FROM CASE v.mode WHEN 'DIRECT' THEN v.bank_account_id ELSE v.clearing_account_id END) THEN
  RAISE EXCEPTION 'cash_bank_event_mode' USING ERRCODE='23514'; END IF;
 NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_bank_event_mode BEFORE INSERT OR UPDATE OR DELETE ON cash_bank_event_modes FOR EACH ROW EXECUTE FUNCTION protect_cash_bank_event_mode();
CREATE FUNCTION freeze_cash_bank_event_mode() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO cash_bank_event_modes(event_id,version_id,mode,account_id)
  SELECT NEW.id,v.id,v.mode,CASE v.mode WHEN 'DIRECT' THEN v.bank_account_id ELSE v.clearing_account_id END
  FROM cash_bank_method_settings s JOIN cash_bank_method_versions v ON v.id=s.active_version_id
  WHERE s.company_id=NEW.company_id AND s.payment_method_id=NEW.payment_method_id;
 RETURN NULL;
END $$;
CREATE TRIGGER freeze_cash_bank_event_mode AFTER INSERT ON cash_money_events FOR EACH ROW WHEN (NEW.settlement_kind='BANK') EXECUTE FUNCTION freeze_cash_bank_event_mode();

-- Asiento de liquidación con fuente única (el valor nuevo no se usa en esta misma transacción).
ALTER TYPE "JournalSourceType" ADD VALUE IF NOT EXISTS 'CASH_SETTLEMENT';

-- Depósito real del proveedor: de la empresa, con importe total; cada sucursal liquida su parte sin exceder el total.
CREATE TABLE cash_bank_deposits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 payment_method_id integer NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,version_id uuid NOT NULL REFERENCES cash_bank_method_versions(id) ON DELETE RESTRICT,
 reference varchar(120) NOT NULL CHECK(length(btrim(reference))>0),deposited_on date NOT NULL,currency_code varchar(3) NOT NULL,
 total_amount numeric(12,2) NOT NULL CHECK(total_amount>0 AND total_amount<=9999999999.99),
 created_by_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,payment_method_id,reference)
);
CREATE TABLE cash_settlements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,branch_id uuid NOT NULL,
 deposit_id uuid NOT NULL REFERENCES cash_bank_deposits(id) ON DELETE RESTRICT,currency_code varchar(3) NOT NULL,
 gross numeric(12,2) NOT NULL CHECK(gross>=0),refunds numeric(12,2) NOT NULL CHECK(refunds>=0),deductions numeric(12,2) NOT NULL CHECK(deductions>=0),
 net numeric(12,2) NOT NULL CHECK(net>0),
 status varchar(8) NOT NULL DEFAULT 'POSTED' CHECK(status IN('POSTED','VOIDED')),
 void_reason varchar(500),voided_by_id uuid REFERENCES users(id) ON DELETE RESTRICT,voided_at timestamptz(3),
 journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,void_entry_id uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
 created_by_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,request_key uuid NOT NULL,request_hash varchar(64) NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id) ON DELETE RESTRICT,
 UNIQUE(company_id,branch_id,created_by_id,request_key),
 -- Bruto − reembolsos − deducciones = neto depositado, exacto al centavo.
 CONSTRAINT cash_settlement_balance CHECK(gross-refunds-deductions=net),
 CHECK(status='POSTED' AND num_nonnulls(void_reason,voided_by_id,voided_at,void_entry_id)=0
  OR status='VOIDED' AND length(btrim(coalesce(void_reason,'')))>0 AND voided_by_id IS NOT NULL AND voided_at IS NOT NULL)
);
CREATE INDEX cash_settlements_deposit ON cash_settlements(deposit_id,status);
-- Asignación con signo: un cobro diferido suma, un reembolso diferido resta.
CREATE TABLE cash_settlement_allocations (
 settlement_id uuid NOT NULL REFERENCES cash_settlements(id) ON DELETE RESTRICT,event_id uuid NOT NULL REFERENCES cash_bank_event_modes(event_id) ON DELETE RESTRICT,
 amount numeric(12,2) NOT NULL CHECK(amount<>0),PRIMARY KEY(settlement_id,event_id)
);
CREATE INDEX cash_settlement_allocations_event ON cash_settlement_allocations(event_id);
CREATE TABLE cash_settlement_deductions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),settlement_id uuid NOT NULL REFERENCES cash_settlements(id) ON DELETE RESTRICT,
 kind varchar(10) NOT NULL CHECK(kind IN('FEE','CHARGEBACK','OTHER')),amount numeric(12,2) NOT NULL CHECK(amount>0),
 account_id integer REFERENCES accounts(id) ON DELETE RESTRICT,description varchar(300) NOT NULL CHECK(length(btrim(description))>0),
 event_id uuid REFERENCES cash_bank_event_modes(event_id) ON DELETE RESTRICT,
 CHECK(kind<>'CHARGEBACK' OR event_id IS NOT NULL)
);

CREATE FUNCTION protect_cash_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dep record;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'cash_settlement_state' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO dep FROM cash_bank_deposits WHERE id=NEW.deposit_id FOR UPDATE;
  IF NEW.status<>'POSTED' OR dep.company_id<>NEW.company_id OR dep.currency_code<>NEW.currency_code OR NEW.journal_entry_id IS NOT NULL THEN
   RAISE EXCEPTION 'cash_settlement_state' USING ERRCODE='23514'; END IF;
  IF (SELECT coalesce(sum(net),0) FROM cash_settlements WHERE deposit_id=NEW.deposit_id AND status='POSTED')+NEW.net>dep.total_amount THEN
   RAISE EXCEPTION 'cash_settlement_deposit_total' USING ERRCODE='23514'; END IF;
  NEW.created_at=clock_timestamp();
  RETURN NEW;
 END IF;
 -- Solo se enlaza su asiento una vez, y POSTED→VOIDED con motivo (enlazando el contra-asiento).
 IF (to_jsonb(NEW)-ARRAY['status','void_reason','voided_by_id','voided_at','journal_entry_id','void_entry_id'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','void_reason','voided_by_id','voided_at','journal_entry_id','void_entry_id'])
  OR OLD.journal_entry_id IS NOT NULL AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
  OR OLD.void_entry_id IS NOT NULL AND NEW.void_entry_id IS DISTINCT FROM OLD.void_entry_id
  OR OLD.status='VOIDED' AND (NEW.status,NEW.void_reason,NEW.voided_by_id) IS DISTINCT FROM (OLD.status,OLD.void_reason,OLD.voided_by_id)
  OR NEW.status='POSTED' AND NEW.void_entry_id IS NOT NULL THEN
  RAISE EXCEPTION 'cash_settlement_state' USING ERRCODE='23514'; END IF;
 IF OLD.status='POSTED' AND NEW.status='VOIDED' THEN NEW.voided_at=clock_timestamp(); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_settlement BEFORE INSERT OR UPDATE OR DELETE ON cash_settlements FOR EACH ROW EXECUTE FUNCTION protect_cash_settlement();

-- Una asignación: evento diferido del mismo medio, sucursal y moneda, con el signo de su dirección, sin exceder su saldo vigente.
CREATE FUNCTION protect_cash_settlement_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ev record; st record; used numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'cash_settlement_state' USING ERRCODE='23514'; END IF;
 SELECT e.*,m.mode INTO ev FROM cash_bank_event_modes m JOIN cash_money_events e ON e.id=m.event_id WHERE m.event_id=NEW.event_id FOR UPDATE OF m;
 SELECT s.*,d.payment_method_id INTO st FROM cash_settlements s JOIN cash_bank_deposits d ON d.id=s.deposit_id WHERE s.id=NEW.settlement_id;
 IF ev.mode<>'DEFERRED' OR st.status<>'POSTED' OR ev.company_id<>st.company_id OR ev.branch_id<>st.branch_id OR ev.payment_method_id<>st.payment_method_id
  OR ev.currency_code<>st.currency_code OR (ev.direction='IN')<>(NEW.amount>0) THEN
  RAISE EXCEPTION 'cash_settlement_allocation' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(abs(a.amount)),0) INTO used FROM cash_settlement_allocations a JOIN cash_settlements s ON s.id=a.settlement_id WHERE a.event_id=NEW.event_id AND s.status='POSTED';
 IF used+abs(NEW.amount)>ev.amount THEN RAISE EXCEPTION 'cash_settlement_exceeds' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_settlement_allocation BEFORE INSERT OR UPDATE OR DELETE ON cash_settlement_allocations FOR EACH ROW EXECUTE FUNCTION protect_cash_settlement_allocation();
CREATE FUNCTION protect_cash_settlement_deduction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM cash_settlements WHERE id=NEW.settlement_id AND status='POSTED') THEN RAISE EXCEPTION 'cash_settlement_state' USING ERRCODE='23514'; END IF;
 IF NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounts a JOIN cash_settlements s ON s.company_id=a.company_id WHERE a.id=NEW.account_id AND s.id=NEW.settlement_id AND a.active AND NOT a.is_group) THEN
  RAISE EXCEPTION 'cash_settlement_account' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_settlement_deduction BEFORE INSERT OR UPDATE OR DELETE ON cash_settlement_deductions FOR EACH ROW EXECUTE FUNCTION protect_cash_settlement_deduction();
CREATE FUNCTION protect_cash_bank_deposit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM cash_bank_method_versions WHERE id=NEW.version_id AND company_id=NEW.company_id AND payment_method_id=NEW.payment_method_id AND mode='DEFERRED' AND status='APPROVED') THEN
  RAISE EXCEPTION 'cash_settlement_deposit' USING ERRCODE='23514'; END IF;
 NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_bank_deposit BEFORE INSERT OR UPDATE OR DELETE ON cash_bank_deposits FOR EACH ROW EXECUTE FUNCTION protect_cash_bank_deposit();
-- Al confirmar: los totales del documento son exactamente la suma de sus asignaciones y deducciones.
CREATE FUNCTION require_cash_settlement_totals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
 SELECT * INTO s FROM cash_settlements WHERE id=NEW.id;
 IF s.gross<>(SELECT coalesce(sum(amount) FILTER (WHERE amount>0),0) FROM cash_settlement_allocations WHERE settlement_id=s.id)
  OR s.refunds<>(SELECT coalesce(-sum(amount) FILTER (WHERE amount<0),0) FROM cash_settlement_allocations WHERE settlement_id=s.id)
  OR s.deductions<>(SELECT coalesce(sum(amount),0) FROM cash_settlement_deductions WHERE settlement_id=s.id)
  OR NOT EXISTS(SELECT 1 FROM cash_settlement_allocations WHERE settlement_id=s.id) THEN
  RAISE EXCEPTION 'cash_settlement_totals' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER require_cash_settlement_totals AFTER INSERT ON cash_settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cash_settlement_totals();
