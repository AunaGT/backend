CREATE TABLE cash_closure_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  closure_id uuid NOT NULL REFERENCES cash_closures(id) ON DELETE RESTRICT,
  previous_correction_id uuid REFERENCES cash_closure_corrections(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  sequence integer CHECK(sequence>0),
  currency_code text NOT NULL CHECK(currency_code ~ '^[A-Z]{3}$'),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  accounting_date date NOT NULL,
  proposed_by_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  proposed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  base_key text NOT NULL CHECK(length(base_key)=64),
  content_hash text NOT NULL CHECK(length(content_hash)=64),
  denominations jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(denominations)='array'),
  decided_by_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  decision_reason text CHECK(decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 1 AND 1000),
  self_review boolean NOT NULL DEFAULT false,
  policy_snapshot jsonb,
  accounting_status text NOT NULL DEFAULT 'DEFERRED' CHECK(accounting_status IN ('DEFERRED','POSTED','ZERO')),
  journal_entry_id uuid UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  cash_account_id integer REFERENCES accounts(id) ON DELETE RESTRICT,
  difference_account_id integer REFERENCES accounts(id) ON DELETE RESTRICT,
  UNIQUE(closure_id,sequence),
  CHECK((status='PENDING' AND decided_by_id IS NULL AND decided_at IS NULL AND sequence IS NULL) OR
    (status<>'PENDING' AND decided_by_id IS NOT NULL AND decided_at IS NOT NULL AND (status='APPROVED')=(sequence IS NOT NULL))),
  CHECK((accounting_status='POSTED')=(journal_entry_id IS NOT NULL)),
  CHECK((cash_account_id IS NULL)=(difference_account_id IS NULL)),
  CHECK(status='APPROVED' OR accounting_status='DEFERRED')
);
CREATE INDEX cash_correction_parent ON cash_closure_corrections(company_id,branch_id,closure_id,proposed_at DESC,id);
CREATE TABLE cash_closure_correction_lines (
  correction_id uuid NOT NULL REFERENCES cash_closure_corrections(id) ON DELETE RESTRICT,
  closure_payment_id integer NOT NULL REFERENCES cash_closure_payments(id) ON DELETE RESTRICT,
  payment_method_id integer NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,
  payment_method_name text NOT NULL,
  settlement_kind text NOT NULL CHECK(settlement_kind IN ('CASH','BANK')),
  original_expected numeric(12,2) NOT NULL,
  previous_actual numeric(12,2) NOT NULL,
  corrected_actual numeric(12,2) NOT NULL CHECK(corrected_actual>=0),
  delta numeric(13,2) NOT NULL,
  corrected_difference numeric(13,2) NOT NULL,
  PRIMARY KEY(correction_id,closure_payment_id),
  CHECK(delta=corrected_actual-previous_actual),
  CHECK(corrected_difference=corrected_actual-original_expected)
);
CREATE TABLE cash_closure_correction_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  correction_id uuid NOT NULL REFERENCES cash_closure_corrections(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK(action IN ('PROPOSE','APPROVE','REJECT','CANCEL')),
  request_key uuid NOT NULL,
  content_hash text NOT NULL CHECK(length(content_hash)=64),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(company_id,actor_id,action,request_key)
);
CREATE FUNCTION guard_cash_correction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record; previous_id uuid; j record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'cash_correction_immutable'; END IF;
  SELECT cc.*,b.company_id INTO c FROM cash_closures cc JOIN branches b ON b.id=cc.branch_id WHERE cc.id=NEW.closure_id FOR UPDATE OF cc;
  IF c.id IS NULL OR c.company_id<>NEW.company_id OR c.branch_id<>NEW.branch_id OR c.status NOT IN ('Aprobado','Cerrado')
    OR c.calculation_snapshot->>'currency_code' IS DISTINCT FROM NEW.currency_code
    OR jsonb_typeof(c.calculation_snapshot->'payment_breakdowns') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'cash_correction_scope_or_snapshot'; END IF;
  SELECT id INTO previous_id FROM cash_closure_corrections WHERE closure_id=NEW.closure_id AND status='APPROVED' ORDER BY sequence DESC LIMIT 1;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PENDING' OR NEW.previous_correction_id IS DISTINCT FROM previous_id OR NEW.accounting_status<>'DEFERRED'
      OR NEW.cash_account_id IS NOT NULL OR NEW.journal_entry_id IS NOT NULL OR NEW.self_review OR NEW.policy_snapshot IS NOT NULL
    THEN RAISE EXCEPTION 'cash_correction_stale_or_state'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['status','sequence','decided_by_id','decided_at','decision_reason','self_review','policy_snapshot','updated_at','accounting_status','journal_entry_id','cash_account_id','difference_account_id'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','sequence','decided_by_id','decided_at','decision_reason','self_review','policy_snapshot','updated_at','accounting_status','journal_entry_id','cash_account_id','difference_account_id'])
    THEN RAISE EXCEPTION 'cash_correction_immutable'; END IF;
    IF OLD.status='PENDING' THEN
      IF NEW.status='PENDING' OR NEW.previous_correction_id IS DISTINCT FROM previous_id AND NEW.status='APPROVED'
        OR NEW.status='APPROVED' AND NEW.sequence IS DISTINCT FROM coalesce((SELECT max(sequence) FROM cash_closure_corrections WHERE closure_id=NEW.closure_id),0)+1
        OR NEW.status IN ('CANCELLED','REJECTED') AND NEW.decision_reason IS NULL
        OR NEW.status='CANCELLED' AND NEW.decided_by_id<>OLD.proposed_by_id
      THEN RAISE EXCEPTION 'cash_correction_stale_or_state'; END IF;
    ELSIF OLD.status='APPROVED' AND OLD.accounting_status='DEFERRED' AND NEW.accounting_status IN ('POSTED','ZERO') THEN
      IF (to_jsonb(NEW)-ARRAY['updated_at','accounting_status','journal_entry_id','cash_account_id','difference_account_id']) IS DISTINCT FROM
         (to_jsonb(OLD)-ARRAY['updated_at','accounting_status','journal_entry_id','cash_account_id','difference_account_id']) THEN RAISE EXCEPTION 'cash_correction_immutable'; END IF;
    ELSE RAISE EXCEPTION 'cash_correction_immutable'; END IF;
    NEW.updated_at=greatest(clock_timestamp(),OLD.updated_at+interval '1 millisecond');
  END IF;
  IF NEW.accounting_status='POSTED' THEN
    SELECT * INTO j FROM journal_entries WHERE id=NEW.journal_entry_id;
    IF j.company_id IS DISTINCT FROM NEW.company_id OR j.branch_id IS DISTINCT FROM NEW.branch_id OR j.source_type::text<>'CASH_CLOSURE_CORRECTION' OR j.source_id IS DISTINCT FROM NEW.id::text
    THEN RAISE EXCEPTION 'cash_correction_posting_scope'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_correction_guard BEFORE INSERT OR UPDATE OR DELETE ON cash_closure_corrections FOR EACH ROW EXECUTE FUNCTION guard_cash_correction();
CREATE FUNCTION guard_cash_correction_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h record; p record; f jsonb; previous_amount numeric;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'cash_correction_immutable'; END IF;
  SELECT * INTO h FROM cash_closure_corrections WHERE id=NEW.correction_id FOR UPDATE;
  SELECT p0.*,c.calculation_snapshot INTO p FROM cash_closure_payments p0 JOIN cash_closures c ON c.id=p0.cash_closure_id WHERE p0.id=NEW.closure_payment_id;
  SELECT item INTO f FROM jsonb_array_elements(p.calculation_snapshot->'payment_breakdowns') item WHERE (item->>'id')::int=NEW.closure_payment_id;
  IF h.status<>'PENDING' OR p.cash_closure_id IS DISTINCT FROM h.closure_id OR p.payment_method_id IS DISTINCT FROM NEW.payment_method_id
    OR p.theoretical_amount IS DISTINCT FROM NEW.original_expected OR f->>'settlement_kind' IS DISTINCT FROM NEW.settlement_kind OR f->>'payment_method_name' IS DISTINCT FROM NEW.payment_method_name
  THEN RAISE EXCEPTION 'cash_correction_line_scope'; END IF;
  previous_amount=p.actual_amount;
  IF h.previous_correction_id IS NOT NULL THEN
    SELECT corrected_actual INTO previous_amount FROM cash_closure_correction_lines WHERE correction_id=h.previous_correction_id AND closure_payment_id=NEW.closure_payment_id;
  END IF;
  IF previous_amount IS DISTINCT FROM NEW.previous_actual THEN RAISE EXCEPTION 'cash_correction_line_base'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_correction_line_guard BEFORE INSERT OR UPDATE OR DELETE ON cash_closure_correction_lines FOR EACH ROW EXECUTE FUNCTION guard_cash_correction_line();
CREATE FUNCTION check_cash_correction_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE id0 uuid; h record;
BEGIN
  IF TG_TABLE_NAME='cash_closure_corrections' THEN id0=NEW.id; ELSE id0=NEW.correction_id; END IF;
  SELECT * INTO h FROM cash_closure_corrections WHERE id=id0;
  IF (SELECT count(*) FROM cash_closure_payments WHERE cash_closure_id=h.closure_id)=0 OR
    (SELECT count(*) FROM cash_closure_payments WHERE cash_closure_id=h.closure_id)<>(SELECT count(*) FROM cash_closure_correction_lines WHERE correction_id=id0)
    OR NOT EXISTS(SELECT 1 FROM cash_closure_correction_lines WHERE correction_id=id0 AND delta<>0)
  THEN RAISE EXCEPTION 'cash_correction_incomplete'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cash_correction_complete AFTER INSERT OR UPDATE ON cash_closure_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_correction_complete();
CREATE CONSTRAINT TRIGGER cash_correction_lines_complete AFTER INSERT ON cash_closure_correction_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_correction_complete();
CREATE FUNCTION guard_cash_correction_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'cash_correction_immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM cash_closure_corrections c WHERE c.id=NEW.correction_id AND c.company_id=NEW.company_id)
  THEN RAISE EXCEPTION 'cash_correction_command_scope'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_correction_command_guard BEFORE INSERT OR UPDATE OR DELETE ON cash_closure_correction_commands FOR EACH ROW EXECUTE FUNCTION guard_cash_correction_command();
ALTER TABLE cash_closure_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_closure_correction_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_closure_correction_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cash_closure_corrections,cash_closure_correction_lines,cash_closure_correction_commands FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON cash_closure_corrections,cash_closure_correction_lines,cash_closure_correction_commands FROM anon; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON cash_closure_corrections,cash_closure_correction_lines,cash_closure_correction_commands FROM authenticated; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN REVOKE ALL ON cash_closure_corrections,cash_closure_correction_lines,cash_closure_correction_commands FROM service_role; END IF;
END $$;
