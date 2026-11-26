BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='90s'; SET LOCAL TIME ZONE 'UTC'; SET LOCAL search_path=public;
 SELECT pg_advisory_xact_lock(910020,192202);
 CREATE TEMP TABLE protected_baseline(table_name text,row_count bigint,row_hash text) ON COMMIT DROP;
 DO $$ DECLARE n text; e text; BEGIN
 FOR n IN SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename LOOP
   e:=CASE WHEN n='cash_settlements' THEN 'to_jsonb(t)-''recoveries''' ELSE 'to_jsonb(t)' END;
   EXECUTE format('LOCK TABLE public.%I IN SHARE MODE',n);
   EXECUTE format('INSERT INTO protected_baseline SELECT %L,count(*),md5(coalesce(string_agg(md5((%s)::text),'''' ORDER BY md5((%s)::text)),'''')) FROM public.%I t %s',n,e,e,n,
     CASE WHEN n='_prisma_migrations' THEN 'WHERE migration_name NOT IN (''20261122220000_cash_dispute_sources'',''20261122220100_cash_payment_disputes'')' ELSE '' END);
 END LOOP;
 END $$;
 -- CreateTable
CREATE TABLE "cash_payment_disputes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "customer_id" UUID,
    "payment_method_id" INTEGER NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "claimed" DECIMAL(12,2) NOT NULL,
    "provider_reference" VARCHAR(120) NOT NULL,
    "provider_reference_key" VARCHAR(240) NOT NULL,
    "replaces_dispute_id" UUID,
    "reason" VARCHAR(1000) NOT NULL,
    "deadline" DATE,
    "status" VARCHAR(24) NOT NULL DEFAULT 'OPEN',
    "version" INTEGER NOT NULL DEFAULT 1,
    "won" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_payment_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_dispute_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dispute_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "principal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "fee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reference" VARCHAR(255),
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "economic_on" DATE,
    "accounting_on" DATE,
    "accounting_reason" VARCHAR(1000),
    "reversal_of_id" UUID,
    "settlement_id" UUID,
    "deduction_id" UUID,
    "journal_entry_id" UUID,
    "accounting_status" VARCHAR(16) NOT NULL DEFAULT 'DEFERRED',
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_dispute_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_dispute_proposals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dispute_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "payload" JSONB NOT NULL,
    "preview_key" VARCHAR(64) NOT NULL,
    "expected_version" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "proposed_by_id" UUID NOT NULL,
    "proposed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason" VARCHAR(1000),
    "self_review" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "cash_dispute_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_dispute_commands" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" VARCHAR(40) NOT NULL,
    "request_key" UUID NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_dispute_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_dispute_lots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dispute_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "proposal_id" UUID,
    "event_id" UUID,
    "target_lot_id" UUID,
    "payment_id" UUID,
    "kind" VARCHAR(24) NOT NULL,
    "principal" DECIMAL(12,2) NOT NULL,
    "account_id" INTEGER,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_dispute_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_receipt_restrictions" (
    "payment_id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "held" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "retired" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_receipt_restrictions_pkey" PRIMARY KEY ("payment_id","dispute_id")
);

-- CreateTable
CREATE TABLE "customer_dispute_charges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dispute_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "reference" VARCHAR(40) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "issued_on" DATE NOT NULL,
    "due_on" DATE NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_dispute_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_dispute_charge_applications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "charge_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "action" VARCHAR(16) NOT NULL DEFAULT 'APPLY',
    "reversal_of_id" UUID,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_dispute_charge_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_recovery_credits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dispute_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_recovery_credits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_recovery_credit_applications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "credit_id" UUID NOT NULL,
    "sale_id" UUID,
    "charge_id" UUID,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "action" VARCHAR(16) NOT NULL DEFAULT 'APPLY',
    "reversal_of_id" UUID,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_recovery_credit_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_dispute_settings" (
    "company_id" UUID NOT NULL,
    "owner_self_review" BOOLEAN NOT NULL DEFAULT false,
    "dispute_account_id" INTEGER,
    "loss_account_id" INTEGER,
    "fee_account_id" INTEGER,
    "receivables_account_id" INTEGER,
    "advances_account_id" INTEGER,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" UUID NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_dispute_settings_pkey" PRIMARY KEY ("company_id")
);

-- CreateIndex
CREATE INDEX "cash_payment_disputes_event_id_idx" ON "cash_payment_disputes"("event_id");

-- CreateIndex
CREATE INDEX "cash_payment_disputes_company_id_branch_id_created_at_idx" ON "cash_payment_disputes"("company_id", "branch_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "cash_dispute_provider_reference_lookup" ON "cash_payment_disputes"("company_id", "payment_method_id", "provider_reference_key");
CREATE UNIQUE INDEX "cash_dispute_provider_reference" ON "cash_payment_disputes"("company_id", "payment_method_id", "provider_reference_key") WHERE status<>'CANCELLED';
CREATE UNIQUE INDEX "cash_payment_disputes_replaces_dispute_id_key" ON "cash_payment_disputes"("replaces_dispute_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_dispute_scope_key" ON "cash_payment_disputes"("company_id", "branch_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_dispute_events_deduction_id_key" ON "cash_dispute_events"("deduction_id");

-- CreateIndex
CREATE INDEX "cash_dispute_events_dispute_id_created_at_idx" ON "cash_dispute_events"("dispute_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "cash_dispute_event_scope_key" ON "cash_dispute_events"("company_id", "branch_id", "dispute_id", "id");

-- CreateIndex
CREATE INDEX "cash_dispute_proposals_dispute_id_status_idx" ON "cash_dispute_proposals"("dispute_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cash_dispute_proposal_scope_key" ON "cash_dispute_proposals"("company_id", "branch_id", "dispute_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_dispute_command_attempt" ON "cash_dispute_commands"("company_id", "branch_id", "actor_id", "action", "request_key");

-- CreateIndex
CREATE INDEX "cash_dispute_lots_dispute_id_idx" ON "cash_dispute_lots"("dispute_id");

-- CreateIndex
CREATE INDEX "cash_dispute_lots_target_lot_id_idx" ON "cash_dispute_lots"("target_lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_dispute_lot_scope_key" ON "cash_dispute_lots"("company_id", "branch_id", "dispute_id", "id");

-- CreateIndex
CREATE INDEX "customer_receipt_restrictions_company_id_branch_id_customer_idx" ON "customer_receipt_restrictions"("company_id", "branch_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_dispute_charges_lot_id_key" ON "customer_dispute_charges"("lot_id");

-- CreateIndex
CREATE INDEX "customer_dispute_charges_customer_id_due_on_idx" ON "customer_dispute_charges"("customer_id", "due_on");

-- CreateIndex
CREATE UNIQUE INDEX "customer_dispute_charge_scope_key" ON "customer_dispute_charges"("company_id", "branch_id", "customer_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_dispute_charges_company_id_reference_key" ON "customer_dispute_charges"("company_id", "reference");

-- CreateIndex
CREATE INDEX "customer_dispute_charge_applications_charge_id_idx" ON "customer_dispute_charge_applications"("charge_id");

-- CreateIndex
CREATE INDEX "customer_dispute_charge_applications_payment_id_idx" ON "customer_dispute_charge_applications"("payment_id");

-- CreateIndex
CREATE INDEX "customer_recovery_credits_customer_id_idx" ON "customer_recovery_credits"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_recovery_credits_event_id_lot_id_key" ON "customer_recovery_credits"("event_id", "lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_recovery_credit_scope_key" ON "customer_recovery_credits"("company_id", "branch_id", "customer_id", "id");

-- CreateIndex
CREATE INDEX "customer_recovery_credit_applications_credit_id_idx" ON "customer_recovery_credit_applications"("credit_id");

-- CreateIndex
CREATE INDEX "customer_recovery_credit_applications_sale_id_idx" ON "customer_recovery_credit_applications"("sale_id");

-- CreateIndex
CREATE INDEX "customer_recovery_credit_applications_charge_id_idx" ON "customer_recovery_credit_applications"("charge_id");

-- New documents only. Existing money, closures and settlements are never rewritten.
ALTER TABLE cash_payment_disputes ADD FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),
 ADD FOREIGN KEY(replaces_dispute_id) REFERENCES cash_payment_disputes(id),
 ADD FOREIGN KEY(event_id) REFERENCES cash_money_events(id), ADD FOREIGN KEY(customer_id) REFERENCES suppliers(id),
 ADD FOREIGN KEY(created_by_id) REFERENCES users(id), ADD CHECK(claimed>0), ADD CHECK(version>0),
 ADD CHECK(status IN('OPEN','SUBMITTED','WON','PARTIALLY_LOST','LOST','CANCELLED')),
 ADD CHECK(won>=0 AND lost>=0), ADD CHECK(length(btrim(reason))>0 AND length(btrim(provider_reference))>0),
 ADD CHECK((status IN('WON','PARTIALLY_LOST','LOST') AND won+lost=claimed) OR (status IN('OPEN','SUBMITTED','CANCELLED') AND won=0 AND lost=0));
ALTER TABLE cash_dispute_events ADD FOREIGN KEY(company_id,branch_id,dispute_id) REFERENCES cash_payment_disputes(company_id,branch_id,id),
 ADD FOREIGN KEY(actor_id) REFERENCES users(id), ADD FOREIGN KEY(reversal_of_id) REFERENCES cash_dispute_events(id),
 ADD FOREIGN KEY(settlement_id) REFERENCES cash_settlements(id), ADD FOREIGN KEY(deduction_id) REFERENCES cash_settlement_deductions(id),
 ADD FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id), ADD CHECK(principal>=0 AND fee>=0),
 ADD CHECK(kind IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING','BANK_RECOVERY','PROVIDER_RECOVERY','COMPENSATION','COMMUNICATION','EVIDENCE','STATUS','DISPOSITION','ADJUSTMENT')),
 ADD CHECK(accounting_status IN('DEFERRED','POSTED','INTEGRATED','ZERO')),
 ADD CHECK(kind IN('COMMUNICATION','EVIDENCE','STATUS','DISPOSITION','ADJUSTMENT') OR (principal+fee>0 AND economic_on IS NOT NULL)),
 ADD CHECK((kind='COMPENSATION')=(reversal_of_id IS NOT NULL));
ALTER TABLE cash_dispute_proposals ADD FOREIGN KEY(company_id,branch_id,dispute_id) REFERENCES cash_payment_disputes(company_id,branch_id,id),
 ADD FOREIGN KEY(proposed_by_id) REFERENCES users(id), ADD FOREIGN KEY(decided_by_id) REFERENCES users(id),
 ADD CHECK(kind IN('SUBMIT','RESULT','CANCEL','REOPEN','DISPOSITION','COMPENSATE','FORGIVE','CORRECT')),
 ADD CHECK(status IN('PENDING','APPROVED','REJECTED','CANCELLED')), ADD CHECK(expected_version>0),
 ADD CHECK((status='PENDING' AND decided_by_id IS NULL AND decided_at IS NULL) OR (status<>'PENDING' AND decided_by_id IS NOT NULL AND decided_at IS NOT NULL));
ALTER TABLE cash_dispute_commands ADD FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id), ADD FOREIGN KEY(actor_id) REFERENCES users(id), ADD CHECK(content_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE cash_dispute_lots ADD FOREIGN KEY(company_id,branch_id,dispute_id) REFERENCES cash_payment_disputes(company_id,branch_id,id),
 ADD FOREIGN KEY(company_id,branch_id,dispute_id,proposal_id) REFERENCES cash_dispute_proposals(company_id,branch_id,dispute_id,id),
 ADD FOREIGN KEY(company_id,branch_id,dispute_id,event_id) REFERENCES cash_dispute_events(company_id,branch_id,dispute_id,id),
 ADD FOREIGN KEY(company_id,branch_id,dispute_id,target_lot_id) REFERENCES cash_dispute_lots(company_id,branch_id,dispute_id,id),
 ADD FOREIGN KEY(payment_id) REFERENCES customer_payments(id),
 ADD FOREIGN KEY(account_id) REFERENCES accounts(id), ADD CHECK(principal>0),
 ADD CHECK(kind IN('ABSORBED','RECEIPT_RETIRED','CUSTOMER_CHARGE','RECOVERED','COMPENSATED')),
 ADD CHECK((kind IN('RECOVERED','COMPENSATED'))=(target_lot_id IS NOT NULL)), ADD CHECK(proposal_id IS NOT NULL OR event_id IS NOT NULL);
ALTER TABLE customer_receipt_restrictions ADD FOREIGN KEY(company_id,branch_id,dispute_id) REFERENCES cash_payment_disputes(company_id,branch_id,id),
 ADD FOREIGN KEY(branch_id,customer_id,payment_id) REFERENCES customer_payments(branch_id,customer_id,id), ADD CHECK(held>=0 AND retired>=0 AND version>0);
ALTER TABLE customer_dispute_charges ADD FOREIGN KEY(company_id,branch_id,dispute_id,lot_id) REFERENCES cash_dispute_lots(company_id,branch_id,dispute_id,id),
 ADD FOREIGN KEY(customer_id) REFERENCES suppliers(id), ADD FOREIGN KEY(created_by_id) REFERENCES users(id), ADD CHECK(amount>0), ADD CHECK(due_on>=issued_on);
ALTER TABLE customer_dispute_charge_applications ADD FOREIGN KEY(company_id,branch_id,customer_id,charge_id) REFERENCES customer_dispute_charges(company_id,branch_id,customer_id,id),
 ADD FOREIGN KEY(branch_id,customer_id,payment_id) REFERENCES customer_payments(branch_id,customer_id,id), ADD FOREIGN KEY(actor_id) REFERENCES users(id),
 ADD FOREIGN KEY(reversal_of_id) REFERENCES customer_dispute_charge_applications(id), ADD CHECK(amount>0), ADD CHECK(action IN('APPLY','RELEASE')),
 ADD CHECK((action='RELEASE')=(reversal_of_id IS NOT NULL));
ALTER TABLE customer_recovery_credits ADD FOREIGN KEY(company_id,branch_id,dispute_id,event_id) REFERENCES cash_dispute_events(company_id,branch_id,dispute_id,id),
 ADD FOREIGN KEY(company_id,branch_id,dispute_id,lot_id) REFERENCES cash_dispute_lots(company_id,branch_id,dispute_id,id),
 ADD FOREIGN KEY(customer_id) REFERENCES suppliers(id), ADD FOREIGN KEY(actor_id) REFERENCES users(id), ADD CHECK(amount>0);
ALTER TABLE customer_recovery_credit_applications ADD FOREIGN KEY(company_id,branch_id,customer_id,credit_id) REFERENCES customer_recovery_credits(company_id,branch_id,customer_id,id),
 ADD FOREIGN KEY(company_id,branch_id,customer_id,charge_id) REFERENCES customer_dispute_charges(company_id,branch_id,customer_id,id),
 ADD FOREIGN KEY(sale_id) REFERENCES sales(id), ADD FOREIGN KEY(actor_id) REFERENCES users(id), ADD FOREIGN KEY(reversal_of_id) REFERENCES customer_recovery_credit_applications(id),
 ADD CHECK(num_nonnulls(sale_id,charge_id)=1), ADD CHECK(amount>0), ADD CHECK(action IN('APPLY','RELEASE')), ADD CHECK((action='RELEASE')=(reversal_of_id IS NOT NULL));
ALTER TABLE cash_dispute_settings ADD FOREIGN KEY(company_id) REFERENCES companies(id), ADD FOREIGN KEY(updated_by_id) REFERENCES users(id),
 ADD FOREIGN KEY(dispute_account_id) REFERENCES accounts(id), ADD FOREIGN KEY(loss_account_id) REFERENCES accounts(id), ADD FOREIGN KEY(fee_account_id) REFERENCES accounts(id),
 ADD FOREIGN KEY(receivables_account_id) REFERENCES accounts(id), ADD FOREIGN KEY(advances_account_id) REFERENCES accounts(id), ADD CHECK(revision>0);

CREATE FUNCTION cash_dispute_effect_delta(k text,rk text,amount numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN k IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING') THEN amount
 WHEN k IN('BANK_RECOVERY','PROVIDER_RECOVERY') THEN -amount
 WHEN k='COMPENSATION' AND rk IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING') THEN -amount
 WHEN k='COMPENSATION' AND rk IN('BANK_RECOVERY','PROVIDER_RECOVERY') THEN amount ELSE 0 END
$$;
CREATE FUNCTION cash_dispute_lock_origin(cid uuid,eid uuid) RETURNS void LANGUAGE sql AS $$
 SELECT pg_advisory_xact_lock(hashtextextended(format('["cash-dispute-origin","%s","%s"]',cid,eid),0))
$$;
CREATE FUNCTION protect_cash_payment_dispute() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e cash_money_events; customer uuid; previous cash_payment_disputes;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'dispute_immutable'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['status','version','won','lost'])<>(to_jsonb(OLD)-ARRAY['status','version','won','lost']) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'dispute_immutable'; END IF;
  IF (NEW.status,NEW.won,NEW.lost) IS DISTINCT FROM (OLD.status,OLD.won,OLD.lost) AND NOT EXISTS(
   SELECT 1 FROM cash_dispute_proposals p WHERE p.dispute_id=OLD.id AND p.expected_version=OLD.version AND p.status='APPROVED' AND (
    (p.kind='SUBMIT' AND OLD.status='OPEN' AND NEW.status='SUBMITTED' AND NEW.won=0 AND NEW.lost=0)
    OR (p.kind='RESULT' AND OLD.status IN('OPEN','SUBMITTED') AND NEW.status=CASE WHEN (p.payload->>'lost')::numeric=0 THEN 'WON' WHEN (p.payload->>'won')::numeric=0 THEN 'LOST' ELSE 'PARTIALLY_LOST' END AND NEW.won=(p.payload->>'won')::numeric AND NEW.lost=(p.payload->>'lost')::numeric)
    OR (p.kind='CANCEL' AND OLD.status IN('OPEN','SUBMITTED') AND NEW.status='CANCELLED' AND NEW.won=0 AND NEW.lost=0)
    OR (p.kind='REOPEN' AND OLD.status IN('WON','PARTIALLY_LOST','LOST') AND NEW.status='OPEN' AND NEW.won=0 AND NEW.lost=0)
   )) THEN RAISE EXCEPTION 'dispute_decision_required'; END IF;
  IF NEW.status='CANCELLED' AND OLD.status<>'CANCELLED' AND (
   coalesce((SELECT sum(cash_dispute_effect_delta(ev.kind,r.kind,ev.principal)) FROM cash_dispute_events ev LEFT JOIN cash_dispute_events r ON r.id=ev.reversal_of_id WHERE ev.dispute_id=OLD.id),0)<>0
   OR coalesce((SELECT sum(CASE WHEN kind='COMPENSATION' THEN -fee WHEN kind IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING','BANK_RECOVERY','PROVIDER_RECOVERY') THEN fee ELSE 0 END) FROM cash_dispute_events WHERE dispute_id=OLD.id),0)<>0
   OR coalesce((SELECT sum(CASE WHEN kind IN('ABSORBED','RECEIPT_RETIRED','CUSTOMER_CHARGE') THEN principal ELSE -principal END) FROM cash_dispute_lots WHERE dispute_id=OLD.id),0)<>0
   OR EXISTS(SELECT 1 FROM customer_dispute_charges WHERE dispute_id=OLD.id)
  ) THEN RAISE EXCEPTION 'dispute_cancel_has_effects'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO e FROM cash_money_events WHERE id=NEW.event_id;
 IF e.id IS NULL OR e.company_id<>NEW.company_id OR e.branch_id<>NEW.branch_id OR e.payment_method_id<>NEW.payment_method_id OR e.currency_code<>NEW.currency_code OR e.direction<>'IN' OR e.settlement_kind<>'BANK' OR e.source_type NOT IN('SALE','CUSTOMER_PAYMENT') THEN RAISE EXCEPTION 'dispute_scope'; END IF;
 IF e.source_type='CUSTOMER_PAYMENT' THEN SELECT customer_id INTO customer FROM customer_payments WHERE id=e.source_id;
 ELSE SELECT customer_contact_id INTO customer FROM sales WHERE id=e.source_id; END IF;
 IF NEW.customer_id IS DISTINCT FROM customer THEN RAISE EXCEPTION 'dispute_scope'; END IF;
 IF NEW.replaces_dispute_id IS NOT NULL THEN
  SELECT * INTO previous FROM cash_payment_disputes WHERE id=NEW.replaces_dispute_id;
  IF previous.id IS NULL OR previous.status<>'CANCELLED' OR previous.company_id<>NEW.company_id OR previous.branch_id<>NEW.branch_id OR previous.payment_method_id<>NEW.payment_method_id OR previous.provider_reference_key<>NEW.provider_reference_key THEN RAISE EXCEPTION 'dispute_replacement_invalid'; END IF;
 ELSIF EXISTS(SELECT 1 FROM cash_payment_disputes WHERE company_id=NEW.company_id AND payment_method_id=NEW.payment_method_id AND provider_reference_key=NEW.provider_reference_key AND status='CANCELLED') THEN
  RAISE EXCEPTION 'dispute_replacement_required';
 END IF;
 IF NEW.status<>'OPEN' OR NEW.version<>1 OR NEW.won<>0 OR NEW.lost<>0 THEN RAISE EXCEPTION 'dispute_initial_state'; END IF;
 PERFORM cash_dispute_lock_origin(NEW.company_id,NEW.event_id);
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_payment_dispute BEFORE INSERT OR UPDATE OR DELETE ON cash_payment_disputes FOR EACH ROW EXECUTE FUNCTION protect_cash_payment_dispute();

CREATE FUNCTION check_cash_dispute_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid uuid;
BEGIN
 IF TG_TABLE_NAME='cash_payment_disputes' THEN eid:=NEW.event_id;
 ELSE SELECT event_id INTO eid FROM cash_payment_disputes WHERE id=NEW.dispute_id; END IF;
 PERFORM assert_cash_dispute_origin_coverage(eid);
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cash_dispute_coverage AFTER INSERT OR UPDATE ON cash_payment_disputes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_coverage();
CREATE CONSTRAINT TRIGGER cash_dispute_effect_coverage AFTER INSERT ON cash_dispute_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_coverage();

CREATE FUNCTION protect_cash_dispute_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d cash_payment_disputes; r cash_dispute_events; exposure numeric; used numeric; used_fee numeric; deduction record;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'dispute_immutable'; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.journal_entry_id IS NOT NULL OR OLD.accounting_status<>'DEFERRED' OR NEW.journal_entry_id IS NULL OR NEW.accounting_status NOT IN('POSTED','INTEGRATED') OR (to_jsonb(NEW)-ARRAY['journal_entry_id','accounting_status','accounting_on','accounting_reason'])<>(to_jsonb(OLD)-ARRAY['journal_entry_id','accounting_status','accounting_on','accounting_reason']) THEN RAISE EXCEPTION 'dispute_immutable'; END IF;
  IF NEW.accounting_on IS NULL OR (OLD.accounting_on IS NOT NULL AND OLD.accounting_on<>NEW.accounting_on) OR (NEW.economic_on<>NEW.accounting_on AND coalesce(length(btrim(NEW.accounting_reason)),0)=0) THEN RAISE EXCEPTION 'dispute_accounting_date'; END IF;
  IF NOT EXISTS(SELECT 1 FROM journal_entries j WHERE j.id=NEW.journal_entry_id AND j.company_id=NEW.company_id AND j.branch_id=NEW.branch_id
    AND ((NEW.accounting_status='POSTED' AND j.source_type='CASH_DISPUTE_EFFECT' AND j.source_id=NEW.id::text)
      OR (NEW.accounting_status='INTEGRATED' AND j.source_type='CASH_SETTLEMENT' AND j.source_id=NEW.settlement_id::text))) THEN RAISE EXCEPTION 'dispute_accounting_source'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO d FROM cash_payment_disputes WHERE id=NEW.dispute_id;
 IF d.id IS NULL THEN RAISE EXCEPTION 'dispute_scope'; END IF;
 IF NEW.kind IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING','BANK_RECOVERY','PROVIDER_RECOVERY','COMPENSATION') AND (NEW.accounting_status<>'DEFERRED' OR NEW.journal_entry_id IS NOT NULL) THEN RAISE EXCEPTION 'dispute_initial_accounting_state'; END IF;
 PERFORM cash_dispute_lock_origin(d.company_id,d.event_id);
 PERFORM 1 FROM cash_payment_disputes WHERE id=d.id FOR UPDATE;
 IF NEW.kind='LEGACY_WITHHOLDING' THEN
  SELECT x.*,s.company_id,s.branch_id,s.currency_code,s.status,b.payment_method_id INTO deduction
   FROM cash_settlement_deductions x JOIN cash_settlements s ON s.id=x.settlement_id JOIN cash_bank_deposits b ON b.id=s.deposit_id
   WHERE x.id=NEW.deduction_id AND s.id=NEW.settlement_id FOR UPDATE OF s;
  IF deduction.id IS NULL OR deduction.company_id<>d.company_id OR deduction.branch_id<>d.branch_id OR deduction.currency_code<>d.currency_code
    OR deduction.payment_method_id<>d.payment_method_id OR deduction.kind<>'CHARGEBACK' OR deduction.status<>'POSTED'
    OR deduction.event_id<>d.event_id OR deduction.amount<>NEW.principal OR NEW.fee<>0 THEN RAISE EXCEPTION 'dispute_legacy_deduction'; END IF;
 END IF;
 IF NEW.kind='COMPENSATION' THEN
  SELECT * INTO r FROM cash_dispute_events WHERE id=NEW.reversal_of_id;
  SELECT coalesce(sum(principal),0),coalesce(sum(fee),0) INTO used,used_fee FROM cash_dispute_events WHERE reversal_of_id=r.id;
  IF r.id IS NULL OR r.dispute_id<>d.id OR r.kind NOT IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING','BANK_RECOVERY','PROVIDER_RECOVERY') OR used+NEW.principal>r.principal OR used_fee+NEW.fee>r.fee THEN RAISE EXCEPTION 'dispute_compensation'; END IF;
 END IF;
 SELECT coalesce(sum(cash_dispute_effect_delta(e.kind,o.kind,e.principal)),0) INTO exposure FROM cash_dispute_events e LEFT JOIN cash_dispute_events o ON o.id=e.reversal_of_id WHERE e.dispute_id=d.id;
 exposure:=exposure+cash_dispute_effect_delta(NEW.kind,r.kind,NEW.principal);
 IF exposure<0 OR exposure>d.claimed THEN RAISE EXCEPTION 'dispute_effect_budget'; END IF;
 IF d.status='CANCELLED' AND NEW.kind NOT IN('COMMUNICATION','EVIDENCE') AND NOT (
  NEW.kind='STATUS' AND NEW.principal=0 AND NEW.fee=0 AND NEW.payload->>'status'='CANCELLED'
  AND EXISTS(SELECT 1 FROM cash_dispute_proposals p WHERE p.id::text=NEW.payload->>'proposalId' AND p.dispute_id=d.id AND p.kind='CANCEL' AND p.status='APPROVED' AND p.expected_version=d.version-1)
 ) THEN RAISE EXCEPTION 'dispute_cancelled'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_dispute_event BEFORE INSERT OR UPDATE OR DELETE ON cash_dispute_events FOR EACH ROW EXECUTE FUNCTION protect_cash_dispute_event();

-- Solo la retención autónoma consume saldo por liquidar; la integrada ya lo consume en su asignación.
CREATE FUNCTION cash_dispute_provider_withheld(eid uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT coalesce(sum(CASE WHEN e.kind='PROVIDER_WITHHOLDING' AND e.settlement_id IS NULL THEN e.principal+e.fee
   WHEN e.kind='COMPENSATION' AND r.kind='PROVIDER_WITHHOLDING' AND r.settlement_id IS NULL THEN -e.principal-e.fee ELSE 0 END),0)
 FROM cash_payment_disputes d JOIN cash_dispute_events e ON e.dispute_id=d.id
 LEFT JOIN cash_dispute_events r ON r.id=e.reversal_of_id WHERE d.event_id=eid
$$;
CREATE FUNCTION protect_cash_dispute_provider_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid uuid; cid uuid; original numeric; used numeric; mode text;
BEGIN
 IF TG_TABLE_NAME='cash_dispute_events' THEN
  IF NEW.kind<>'PROVIDER_WITHHOLDING' OR NEW.settlement_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT event_id,company_id INTO eid,cid FROM cash_payment_disputes WHERE id=NEW.dispute_id;
 ELSE
  eid:=NEW.event_id;
  SELECT company_id INTO cid FROM cash_money_events WHERE id=eid;
 END IF;
 PERFORM cash_dispute_lock_origin(cid,eid);
 SELECT e.amount,m.mode INTO original,mode FROM cash_bank_event_modes m JOIN cash_money_events e ON e.id=m.event_id WHERE m.event_id=eid FOR UPDATE OF m;
 SELECT coalesce(sum(abs(a.amount)),0)+cash_dispute_provider_withheld(eid) INTO used
   FROM cash_settlement_allocations a JOIN cash_settlements s ON s.id=a.settlement_id WHERE a.event_id=eid AND s.status='POSTED';
 IF TG_TABLE_NAME='cash_dispute_events' THEN
  IF mode IS DISTINCT FROM 'DEFERRED' OR used+NEW.principal+NEW.fee>original THEN RAISE EXCEPTION 'dispute_provider_balance'; END IF;
 ELSE
  IF used+abs(NEW.amount)>original THEN RAISE EXCEPTION 'cash_settlement_exceeds'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_cash_dispute_provider_balance BEFORE INSERT ON cash_dispute_events FOR EACH ROW EXECUTE FUNCTION protect_cash_dispute_provider_balance();
CREATE TRIGGER cash_dispute_settlement_balance BEFORE INSERT ON cash_settlement_allocations FOR EACH ROW EXECUTE FUNCTION protect_cash_dispute_provider_balance();

CREATE FUNCTION protect_cash_dispute_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'dispute_immutable'; END IF;
 IF TG_OP='UPDATE' AND (OLD.status<>'PENDING' OR NEW.status='PENDING' OR (to_jsonb(NEW)-ARRAY['status','decided_by_id','decided_at','decision_reason','self_review'])<>(to_jsonb(OLD)-ARRAY['status','decided_by_id','decided_at','decision_reason','self_review'])) THEN RAISE EXCEPTION 'dispute_immutable'; END IF;
 IF TG_OP='INSERT' AND NEW.status<>'PENDING' THEN RAISE EXCEPTION 'dispute_initial_state'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_dispute_proposal BEFORE INSERT OR UPDATE OR DELETE ON cash_dispute_proposals FOR EACH ROW EXECUTE FUNCTION protect_cash_dispute_proposal();
CREATE FUNCTION cash_dispute_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'dispute_immutable'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['cash_dispute_commands','cash_dispute_lots','customer_dispute_charges','customer_dispute_charge_applications','customer_recovery_credits','customer_recovery_credit_applications'] LOOP
  EXECUTE format('CREATE TRIGGER dispute_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION cash_dispute_immutable()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['cash_payment_disputes','cash_dispute_events','cash_dispute_proposals','cash_dispute_commands','cash_dispute_lots','customer_receipt_restrictions','customer_dispute_charges','customer_dispute_charge_applications','customer_recovery_credits','customer_recovery_credit_applications','cash_dispute_settings'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM anon',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM service_role',t); END IF;
 END LOOP;
END $$;
CREATE FUNCTION check_cash_dispute_child_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d cash_payment_disputes; l cash_dispute_lots; e cash_money_events;
BEGIN
 SELECT * INTO d FROM cash_payment_disputes WHERE id=NEW.dispute_id;
 IF d.id IS NULL OR d.company_id<>NEW.company_id OR d.branch_id<>NEW.branch_id OR d.customer_id IS DISTINCT FROM NEW.customer_id THEN RAISE EXCEPTION 'dispute_scope'; END IF;
 IF TG_TABLE_NAME='customer_receipt_restrictions' THEN
  SELECT * INTO e FROM cash_money_events WHERE id=d.event_id;
  IF NOT EXISTS(SELECT 1 FROM cash_dispute_receipt_origins(NEW.payment_id) o WHERE o.origin_id=d.event_id) THEN RAISE EXCEPTION 'dispute_scope'; END IF;
  IF TG_OP='UPDATE' AND ((NEW.payment_id,NEW.dispute_id,NEW.company_id,NEW.branch_id,NEW.customer_id) IS DISTINCT FROM (OLD.payment_id,OLD.dispute_id,OLD.company_id,OLD.branch_id,OLD.customer_id) OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'dispute_immutable'; END IF;
 ELSE
  SELECT * INTO l FROM cash_dispute_lots WHERE id=NEW.lot_id;
  IF l.id IS NULL OR l.dispute_id<>d.id OR NEW.currency_code<>d.currency_code THEN RAISE EXCEPTION 'dispute_scope'; END IF;
  IF TG_TABLE_NAME='customer_dispute_charges' AND (l.kind<>'CUSTOMER_CHARGE' OR l.principal<>NEW.amount) THEN RAISE EXCEPTION 'dispute_charge_source'; END IF;
  -- Los cargos no tienen event_id: se lee como JSON para que la expresión compile en ambas tablas.
  IF TG_TABLE_NAME='customer_recovery_credits' AND (l.kind<>'RECOVERED' OR l.principal<NEW.amount OR l.event_id IS DISTINCT FROM (to_jsonb(NEW)->>'event_id')::uuid) THEN RAISE EXCEPTION 'dispute_credit_source'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cash_dispute_restriction_scope BEFORE INSERT OR UPDATE ON customer_receipt_restrictions FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_child_scope();
CREATE TRIGGER cash_dispute_charge_scope BEFORE INSERT ON customer_dispute_charges FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_child_scope();
CREATE TRIGGER cash_dispute_credit_scope BEFORE INSERT ON customer_recovery_credits FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_child_scope();
-- Saldo pendiente de los cargos de un expediente: lo cobrado no cuenta, lo recuperado o compensado sí.
CREATE FUNCTION cash_dispute_charge_open(case_id uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT coalesce(sum(greatest(0,c.amount
  -coalesce((SELECT sum(CASE action WHEN 'APPLY' THEN amount ELSE -amount END) FROM customer_dispute_charge_applications WHERE charge_id=c.id),0)
  -coalesce((SELECT sum(CASE action WHEN 'APPLY' THEN amount ELSE -amount END) FROM customer_recovery_credit_applications WHERE charge_id=c.id),0)
  -coalesce((SELECT sum(x.principal) FROM cash_dispute_lots x WHERE x.target_lot_id=c.lot_id AND (x.kind='COMPENSATED'
    OR x.kind='RECOVERED' AND NOT EXISTS(SELECT 1 FROM customer_recovery_credits k WHERE k.lot_id=x.id))),0))),0)
 FROM customer_dispute_charges c WHERE c.dispute_id=case_id
$$;
CREATE FUNCTION assert_cash_dispute_receipt_budget(pid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE received numeric; applied numeric; committed numeric; refunded numeric; held numeric; retired numeric; charged numeric; needed numeric; expected_held numeric; expected_retired numeric; other_held numeric;
BEGIN
 SELECT amount INTO received FROM customer_payments WHERE id=pid;
 IF received IS NULL THEN RETURN; END IF;
 SELECT coalesce(sum(amount),0) INTO applied FROM sale_payment_entries WHERE customer_payment_id=pid;
 SELECT coalesce(sum(amount),0) INTO committed FROM payment_commitments WHERE payment_id=pid AND state='COMMITTED';
 SELECT cash_dispute_receipt_refunded(pid) INTO refunded;
 SELECT coalesce(sum(r.held),0),coalesce(sum(r.retired),0) INTO held,retired FROM customer_receipt_restrictions r WHERE payment_id=pid;
 SELECT coalesce(sum(CASE action WHEN 'APPLY' THEN amount ELSE -amount END),0) INTO charged FROM customer_dispute_charge_applications WHERE payment_id=pid;
 IF charged<0 OR applied+committed+refunded+held+retired+charged>received THEN RAISE EXCEPTION 'dispute_receipt_budget'; END IF;
 SELECT coalesce(sum(greatest(0,CASE WHEN d.status IN('OPEN','SUBMITTED') THEN d.claimed
   ELSE greatest(greatest(0,d.lost-greatest(0,m.recovered-d.won)),m.exposure) END-m.disposed)+cash_dispute_charge_open(d.id)),0),coalesce(sum(m.retired),0) INTO needed,expected_retired
 FROM cash_payment_disputes d JOIN cash_money_events origin ON origin.id=d.event_id
 CROSS JOIN LATERAL (SELECT
   coalesce((SELECT sum(cash_dispute_effect_delta(e.kind,r.kind,e.principal)) FROM cash_dispute_events e LEFT JOIN cash_dispute_events r ON r.id=e.reversal_of_id WHERE e.dispute_id=d.id),0) AS exposure,
   coalesce((SELECT sum(CASE WHEN e.kind IN('BANK_RECOVERY','PROVIDER_RECOVERY') THEN e.principal WHEN e.kind='COMPENSATION' AND r.kind IN('BANK_RECOVERY','PROVIDER_RECOVERY') THEN -e.principal ELSE 0 END) FROM cash_dispute_events e LEFT JOIN cash_dispute_events r ON r.id=e.reversal_of_id WHERE e.dispute_id=d.id),0) AS recovered,
   coalesce((SELECT sum(CASE WHEN kind IN('ABSORBED','RECEIPT_RETIRED','CUSTOMER_CHARGE') THEN principal ELSE -principal END) FROM cash_dispute_lots WHERE dispute_id=d.id),0) AS disposed,
   coalesce((SELECT sum(l.principal-coalesce((SELECT sum(x.principal) FROM cash_dispute_lots x WHERE x.target_lot_id=l.id AND x.kind IN('RECOVERED','COMPENSATED')),0)) FROM cash_dispute_lots l WHERE l.dispute_id=d.id AND l.kind='RECEIPT_RETIRED' AND l.payment_id=pid),0) AS retired
 ) m WHERE origin.id IN(SELECT origin_id FROM cash_dispute_receipt_origins(pid));
 SELECT coalesce(sum(r.held),0) INTO other_held FROM customer_receipt_restrictions r JOIN cash_payment_disputes d ON d.id=r.dispute_id WHERE r.payment_id<>pid AND d.event_id IN(SELECT origin_id FROM cash_dispute_receipt_origins(pid));
 expected_held:=least(greatest(0,received-applied-committed-refunded-charged-retired),greatest(0,needed-other_held));
 IF held<>expected_held OR retired<>expected_retired THEN RAISE EXCEPTION 'dispute_receipt_reservation_stale'; END IF;
 PERFORM assert_cash_dispute_origin_coverage(origin_id) FROM cash_dispute_receipt_origins(pid);
END $$;
CREATE FUNCTION check_cash_dispute_receipt_budget() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM assert_cash_dispute_receipt_budget(NEW.payment_id); RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cash_dispute_receipt_budget AFTER INSERT OR UPDATE ON customer_receipt_restrictions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_receipt_budget();
CREATE CONSTRAINT TRIGGER cash_dispute_receipt_application_budget AFTER INSERT ON customer_dispute_charge_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_receipt_budget();
CREATE CONSTRAINT TRIGGER cash_dispute_retirement_budget AFTER INSERT ON cash_dispute_lots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_receipt_budget();
CREATE FUNCTION protect_cash_dispute_restriction_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'dispute_immutable'; END $$;
CREATE TRIGGER cash_dispute_restriction_delete BEFORE DELETE ON customer_receipt_restrictions FOR EACH ROW EXECUTE FUNCTION protect_cash_dispute_restriction_delete();
CREATE FUNCTION protect_cash_dispute_lot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d cash_payment_disputes; p cash_dispute_proposals; e cash_dispute_events; target cash_dispute_lots; used numeric; exposure numeric; disposed numeric; allowed numeric;
BEGIN
 SELECT * INTO d FROM cash_payment_disputes WHERE id=NEW.dispute_id;
 IF d.id IS NULL THEN RAISE EXCEPTION 'dispute_scope'; END IF;
 PERFORM cash_dispute_lock_origin(d.company_id,d.event_id);
 PERFORM 1 FROM cash_payment_disputes WHERE id=d.id FOR UPDATE;
 IF NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id AND company_id=d.company_id AND active AND NOT is_group) THEN RAISE EXCEPTION 'dispute_account_scope'; END IF;
 IF NEW.kind='RECEIPT_RETIRED' AND NEW.payment_id IS NULL THEN RAISE EXCEPTION 'dispute_retired_receipt'; END IF;
 IF NEW.payment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM customer_payments receipt JOIN cash_dispute_receipt_origins(receipt.id) o ON o.origin_id=d.event_id WHERE receipt.id=NEW.payment_id AND receipt.branch_id=d.branch_id AND receipt.customer_id=d.customer_id) THEN RAISE EXCEPTION 'dispute_retired_receipt'; END IF;
 IF NEW.kind IN('ABSORBED','RECEIPT_RETIRED','CUSTOMER_CHARGE') THEN
  SELECT * INTO p FROM cash_dispute_proposals WHERE id=NEW.proposal_id AND dispute_id=d.id;
  IF p.id IS NULL OR p.status<>'APPROVED' OR p.kind NOT IN('DISPOSITION','FORGIVE','CORRECT') OR p.expected_version<>d.version THEN RAISE EXCEPTION 'dispute_proposal_required'; END IF;
  SELECT coalesce(sum(cash_dispute_effect_delta(ev.kind,r.kind,ev.principal)),0) INTO exposure FROM cash_dispute_events ev LEFT JOIN cash_dispute_events r ON r.id=ev.reversal_of_id WHERE ev.dispute_id=d.id;
  SELECT coalesce(sum(CASE WHEN kind IN('ABSORBED','RECEIPT_RETIRED','CUSTOMER_CHARGE') THEN principal ELSE -principal END),0) INTO disposed FROM cash_dispute_lots WHERE dispute_id=d.id;
  IF disposed+NEW.principal>least(d.lost,exposure) THEN RAISE EXCEPTION 'dispute_disposition_budget'; END IF;
  IF NEW.kind='ABSORBED' THEN
   allowed:=coalesce((p.payload->>'absorbedPrincipal')::numeric,0);
   SELECT coalesce(sum(principal),0) INTO used FROM cash_dispute_lots WHERE proposal_id=p.id AND kind='ABSORBED';
  ELSE
   allowed:=coalesce((p.payload->>'customerPrincipal')::numeric,0);
   SELECT coalesce(sum(principal),0) INTO used FROM cash_dispute_lots WHERE proposal_id=p.id AND kind IN('RECEIPT_RETIRED','CUSTOMER_CHARGE');
  END IF;
  IF used+NEW.principal>allowed THEN RAISE EXCEPTION 'dispute_proposal_budget'; END IF;
 ELSE
  SELECT * INTO target FROM cash_dispute_lots WHERE id=NEW.target_lot_id AND dispute_id=d.id;
  IF target.id IS NULL OR target.kind NOT IN('ABSORBED','RECEIPT_RETIRED','CUSTOMER_CHARGE') THEN RAISE EXCEPTION 'dispute_lot_target'; END IF;
  IF NEW.payment_id IS DISTINCT FROM target.payment_id THEN RAISE EXCEPTION 'dispute_retired_receipt'; END IF;
  SELECT coalesce(sum(principal),0) INTO used FROM cash_dispute_lots WHERE target_lot_id=target.id AND kind IN('RECOVERED','COMPENSATED');
  IF used+NEW.principal>target.principal THEN RAISE EXCEPTION 'dispute_lot_budget'; END IF;
  IF NEW.kind='RECOVERED' THEN
   SELECT * INTO e FROM cash_dispute_events WHERE id=NEW.event_id AND dispute_id=d.id;
   SELECT coalesce(sum(principal),0) INTO used FROM cash_dispute_lots WHERE event_id=e.id AND kind='RECOVERED';
   IF e.id IS NULL OR e.kind NOT IN('BANK_RECOVERY','PROVIDER_RECOVERY') OR used+NEW.principal>e.principal THEN RAISE EXCEPTION 'dispute_recovery_source'; END IF;
  ELSE
   IF target.kind='ABSORBED' AND EXISTS(SELECT 1 FROM cash_refund_allocations WHERE funding_lot_id=target.id) THEN RAISE EXCEPTION 'refund_funding_descendants'; END IF;
   SELECT * INTO p FROM cash_dispute_proposals WHERE id=NEW.proposal_id AND dispute_id=d.id;
   IF p.id IS NULL OR p.status<>'APPROVED' OR p.kind NOT IN('FORGIVE','CORRECT','COMPENSATE') OR p.expected_version<>d.version THEN RAISE EXCEPTION 'dispute_proposal_required'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_dispute_lot BEFORE INSERT ON cash_dispute_lots FOR EACH ROW EXECUTE FUNCTION protect_cash_dispute_lot();

-- Older receipt writers must not publish newly released money while a claim holds it.
CREATE FUNCTION check_cash_dispute_legacy_receipt_writer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_pid uuid; next_pid uuid; pid uuid; field_name text;
BEGIN
 field_name:=CASE WHEN TG_TABLE_NAME='sale_payment_entries' THEN 'customer_payment_id' ELSE 'payment_id' END;
 IF TG_OP<>'INSERT' THEN previous_pid:=(to_jsonb(OLD)->>field_name)::uuid; END IF;
 IF TG_OP<>'DELETE' THEN next_pid:=(to_jsonb(NEW)->>field_name)::uuid; END IF;
 FOR pid IN SELECT DISTINCT v FROM unnest(ARRAY[previous_pid,next_pid]) v WHERE v IS NOT NULL LOOP
  IF EXISTS(SELECT 1 FROM cash_payment_disputes d JOIN cash_dispute_receipt_origins(pid) o ON o.origin_id=d.event_id) THEN PERFORM assert_cash_dispute_receipt_budget(pid); END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cash_dispute_legacy_application AFTER INSERT OR UPDATE OR DELETE ON sale_payment_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_legacy_receipt_writer();
CREATE CONSTRAINT TRIGGER cash_dispute_legacy_commitment AFTER INSERT OR UPDATE OR DELETE ON payment_commitments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_legacy_receipt_writer();
CREATE CONSTRAINT TRIGGER cash_dispute_legacy_refund AFTER INSERT OR UPDATE OR DELETE ON customer_payment_refunds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_legacy_receipt_writer();
CREATE CONSTRAINT TRIGGER cash_dispute_legacy_allocation_event AFTER INSERT OR UPDATE OR DELETE ON payment_allocation_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_legacy_receipt_writer();

-- Generic returns need receipt attribution too; engagement allocation events cannot represent them.
CREATE TABLE cash_refund_allocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, branch_id uuid NOT NULL,
 customer_id uuid NOT NULL, payment_id uuid NOT NULL, origin_event_id uuid REFERENCES cash_money_events(id),
 source_type varchar(32) NOT NULL CHECK(source_type IN('RETURN_SETTLEMENT','CUSTOMER_PAYMENT_REFUND')),
 source_id uuid NOT NULL, action varchar(12) NOT NULL CHECK(action IN('REFUND','RELEASE','TRANSFER')),
 amount numeric(12,2) NOT NULL CHECK(amount>0), funding_lot_id uuid REFERENCES cash_dispute_lots(id),
 actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz(3) NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),
 FOREIGN KEY(branch_id,customer_id,payment_id) REFERENCES customer_payments(branch_id,customer_id,id)
);
CREATE INDEX cash_refund_allocations_payment_id_idx ON cash_refund_allocations(payment_id);
CREATE INDEX cash_refund_allocations_source_type_source_id_idx ON cash_refund_allocations(source_type,source_id);
CREATE INDEX cash_refund_allocations_funding_lot_id_idx ON cash_refund_allocations(funding_lot_id);
CREATE INDEX cash_refund_allocations_origin_event_id_idx ON cash_refund_allocations(origin_event_id);
CREATE UNIQUE INDEX cash_refund_transfer_payment ON cash_refund_allocations(payment_id) WHERE action='TRANSFER';
CREATE TRIGGER dispute_immutable BEFORE UPDATE OR DELETE ON cash_refund_allocations FOR EACH ROW EXECUTE FUNCTION cash_dispute_immutable();
ALTER TABLE cash_refund_allocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cash_refund_allocations FROM PUBLIC;
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE cash_refund_allocations FROM %I',r.rolname);
 END LOOP;
END $$;

CREATE FUNCTION cash_dispute_receipt_origins(pid uuid) RETURNS TABLE(origin_id uuid) LANGUAGE sql STABLE AS $$
 SELECT id FROM cash_money_events WHERE source_type='CUSTOMER_PAYMENT' AND source_id=pid AND direction='IN' AND settlement_kind='BANK'
 UNION SELECT origin_event_id FROM cash_refund_allocations WHERE payment_id=pid AND action='TRANSFER'
$$;

CREATE FUNCTION cash_dispute_receipt_refunded(pid uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT sum(amount) FROM customer_payment_refunds WHERE payment_id=pid AND status='CONFIRMED'),0)
  +coalesce((SELECT sum(amount) FROM payment_allocation_events WHERE payment_id=pid AND action='SALE_REFUNDED'),0)
  +coalesce((SELECT sum(greatest(0,a.amount-coalesce((SELECT sum(e.amount) FROM payment_allocation_events e WHERE e.payment_id=pid AND e.return_settlement_id=a.source_id AND e.action='SALE_REFUNDED'),0)))
    FROM (SELECT source_id,sum(amount) AS amount FROM cash_refund_allocations WHERE payment_id=pid AND action='REFUND' AND source_type='RETURN_SETTLEMENT' GROUP BY source_id) a),0)
$$;
CREATE FUNCTION cash_dispute_funded_refunds(eid uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT coalesce(sum(least(coalesce((SELECT sum(a.amount) FROM cash_refund_allocations a WHERE a.funding_lot_id=l.id AND a.action='REFUND'),0),
  greatest(0,l.principal-coalesce((SELECT sum(c.principal) FROM cash_dispute_lots c WHERE c.target_lot_id=l.id AND c.kind IN('RECOVERED','COMPENSATED')),0)))),0)
 FROM cash_dispute_lots l JOIN cash_payment_disputes d ON d.id=l.dispute_id WHERE d.event_id=eid AND l.kind='ABSORBED'
$$;
CREATE FUNCTION cash_dispute_origin_refunded(eid uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN e.source_type='CUSTOMER_PAYMENT' THEN cash_dispute_receipt_refunded(e.source_id)
  ELSE coalesce((SELECT sum(rs.amount) FROM return_settlements rs JOIN returns r ON r.id=rs.return_id WHERE r.sale_id=e.source_id AND rs.kind='REFUND'),0)
   +coalesce((SELECT sum(a.amount) FROM cash_refund_allocations a WHERE a.origin_event_id=e.id AND a.action='REFUND'
    AND NOT EXISTS(SELECT 1 FROM return_settlements rs JOIN returns r ON r.id=rs.return_id WHERE a.source_type='RETURN_SETTLEMENT' AND a.source_id=rs.id AND r.sale_id=e.source_id)),0) END
 FROM cash_money_events e WHERE e.id=eid
$$;
-- Un resultado perdido que el banco todavía no debita sigue ocupando su principal (misma regla que la reserva del recibo).
CREATE FUNCTION cash_dispute_origin_used(eid uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT coalesce(sum(CASE WHEN d.status IN('OPEN','SUBMITTED') THEN d.claimed
   ELSE greatest(0,coalesce(x.exposure,0),d.lost-greatest(0,coalesce(x.recovered,0)-d.won)) END),0)
 FROM cash_payment_disputes d LEFT JOIN LATERAL (SELECT sum(cash_dispute_effect_delta(ev.kind,r.kind,ev.principal)) AS exposure,
   sum(CASE WHEN ev.kind IN('BANK_RECOVERY','PROVIDER_RECOVERY') THEN ev.principal WHEN ev.kind='COMPENSATION' AND r.kind IN('BANK_RECOVERY','PROVIDER_RECOVERY') THEN -ev.principal ELSE 0 END) AS recovered
  FROM cash_dispute_events ev LEFT JOIN cash_dispute_events r ON r.id=ev.reversal_of_id WHERE ev.dispute_id=d.id) x ON true WHERE d.event_id=eid
$$;
CREATE FUNCTION assert_cash_dispute_origin_coverage(eid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e cash_money_events;
BEGIN
 SELECT * INTO e FROM cash_money_events WHERE id=eid;
 IF e.id IS NULL THEN RAISE EXCEPTION 'refund_origin'; END IF;
 PERFORM cash_dispute_lock_origin(e.company_id,e.id);
 IF cash_dispute_origin_used(e.id)+cash_dispute_origin_refunded(e.id)-cash_dispute_funded_refunds(e.id)>e.amount THEN RAISE EXCEPTION 'dispute_coverage'; END IF;
END $$;
CREATE FUNCTION protect_cash_dispute_refund_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p customer_payments; e cash_money_events; l cash_dispute_lots; d cash_payment_disputes;
 source_amount numeric; source_kind text; source_customer uuid; source_branch uuid; used numeric;
BEGIN
 SELECT * INTO p FROM customer_payments WHERE id=NEW.payment_id;
 IF p.id IS NULL OR p.customer_id<>NEW.customer_id OR p.branch_id<>NEW.branch_id THEN RAISE EXCEPTION 'refund_scope'; END IF;
 IF NEW.source_type='RETURN_SETTLEMENT' THEN
  SELECT rs.amount,rs.kind::text,s.customer_contact_id,s.branch_id INTO source_amount,source_kind,source_customer,source_branch
   FROM return_settlements rs JOIN returns r ON r.id=rs.return_id JOIN sales s ON s.id=r.sale_id WHERE rs.id=NEW.source_id;
  IF NOT ((NEW.action='REFUND' AND source_kind='REFUND') OR (NEW.action IN('RELEASE','TRANSFER') AND source_kind='CUSTOMER_CREDIT')) THEN RAISE EXCEPTION 'refund_source'; END IF;
 ELSE
  SELECT amount,customer_id,branch_id INTO source_amount,source_customer,source_branch FROM customer_payment_refunds WHERE id=NEW.source_id AND status='CONFIRMED' AND payment_id=NEW.payment_id;
  IF NEW.action<>'REFUND' THEN RAISE EXCEPTION 'refund_source'; END IF;
 END IF;
 IF source_amount IS NULL OR source_customer IS DISTINCT FROM NEW.customer_id OR source_branch<>NEW.branch_id THEN RAISE EXCEPTION 'refund_scope'; END IF;
 -- Serialize even receipts without a bank origin: one settlement cannot be attributed twice.
 PERFORM pg_advisory_xact_lock(hashtextextended('cash-refund-source:'||NEW.source_type||':'||NEW.source_id::text,0));
 SELECT coalesce(sum(amount),0) INTO used FROM cash_refund_allocations WHERE source_type=NEW.source_type AND source_id=NEW.source_id;
 IF used+NEW.amount>source_amount THEN RAISE EXCEPTION 'refund_source_budget'; END IF;
 IF NEW.origin_event_id IS NOT NULL THEN
  SELECT * INTO e FROM cash_money_events WHERE id=NEW.origin_event_id;
  IF e.id IS NULL OR e.company_id<>NEW.company_id OR e.branch_id<>NEW.branch_id OR e.direction<>'IN' OR e.settlement_kind<>'BANK'
   OR NOT ((e.source_type='CUSTOMER_PAYMENT' AND e.source_id=NEW.payment_id AND p.kind='PAYMENT')
    OR (e.source_type='SALE' AND NEW.action='TRANSFER' AND p.kind='CREDIT_NOTE' AND e.source_id=(SELECT sale_id FROM returns r JOIN return_settlements rs ON rs.return_id=r.id WHERE rs.id=NEW.source_id))
    OR (e.source_type='SALE' AND NEW.action<>'TRANSFER' AND EXISTS(SELECT 1 FROM cash_refund_allocations a WHERE a.payment_id=p.id AND a.action='TRANSFER' AND a.origin_event_id=e.id))) THEN RAISE EXCEPTION 'refund_origin'; END IF;
  PERFORM cash_dispute_lock_origin(NEW.company_id,e.id);
 END IF;
 IF NEW.action='TRANSFER' AND (p.kind<>'CREDIT_NOTE' OR NEW.origin_event_id IS NULL OR NEW.amount<>p.amount OR NEW.amount<>source_amount) THEN RAISE EXCEPTION 'refund_origin'; END IF;
 IF NEW.funding_lot_id IS NOT NULL THEN
  SELECT * INTO l FROM cash_dispute_lots WHERE id=NEW.funding_lot_id;
  SELECT * INTO d FROM cash_payment_disputes WHERE id=l.dispute_id;
  IF NEW.action<>'REFUND' OR NEW.origin_event_id IS NULL OR l.kind<>'ABSORBED' OR d.event_id<>NEW.origin_event_id OR d.company_id<>NEW.company_id OR d.branch_id<>NEW.branch_id OR d.customer_id IS DISTINCT FROM NEW.customer_id THEN RAISE EXCEPTION 'refund_funding_scope'; END IF;
  SELECT coalesce(sum(amount),0) INTO used FROM cash_refund_allocations WHERE funding_lot_id=l.id;
  IF used+NEW.amount>l.principal-coalesce((SELECT sum(principal) FROM cash_dispute_lots WHERE target_lot_id=l.id AND kind IN('RECOVERED','COMPENSATED')),0) THEN RAISE EXCEPTION 'refund_funding_budget'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cash_dispute_refund_allocation BEFORE INSERT ON cash_refund_allocations FOR EACH ROW EXECUTE FUNCTION protect_cash_dispute_refund_allocation();
CREATE FUNCTION protect_cash_dispute_refund_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source text;
BEGIN
 source:=CASE WHEN TG_TABLE_NAME='return_settlements' THEN 'RETURN_SETTLEMENT' ELSE 'CUSTOMER_PAYMENT_REFUND' END;
 IF EXISTS(SELECT 1 FROM cash_refund_allocations WHERE source_type=source AND source_id=OLD.id) THEN RAISE EXCEPTION 'refund_source_immutable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cash_dispute_return_source BEFORE UPDATE OR DELETE ON return_settlements FOR EACH ROW EXECUTE FUNCTION protect_cash_dispute_refund_source();
CREATE TRIGGER cash_dispute_receipt_refund_source BEFORE UPDATE OR DELETE ON customer_payment_refunds FOR EACH ROW EXECUTE FUNCTION protect_cash_dispute_refund_source();
-- Una devolución de dinero de una venta directa con disputa no puede usar el principal que el reclamo ocupa, aunque la escriba un servicio antiguo.
CREATE FUNCTION check_cash_dispute_sale_refund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid uuid;
BEGIN
 IF NEW.kind<>'REFUND' THEN RETURN NULL; END IF;
 FOR eid IN SELECT e.id FROM cash_money_events e JOIN returns r ON r.sale_id=e.source_id
   WHERE r.id=NEW.return_id AND e.source_type='SALE' AND e.direction='IN' AND e.settlement_kind='BANK'
     AND EXISTS(SELECT 1 FROM cash_payment_disputes d WHERE d.event_id=e.id) ORDER BY e.id LOOP
  PERFORM assert_cash_dispute_origin_coverage(eid);
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cash_dispute_sale_refund AFTER INSERT ON return_settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_sale_refund();
CREATE FUNCTION check_cash_dispute_refund_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM assert_cash_dispute_receipt_budget(NEW.payment_id);
 IF NEW.origin_event_id IS NOT NULL THEN PERFORM assert_cash_dispute_origin_coverage(NEW.origin_event_id); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cash_dispute_refund_receipt AFTER INSERT ON cash_refund_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_refund_receipt();

-- El documento base no se anula por una vía antigua dejando una disputa vigente sin soporte.
CREATE INDEX cash_dispute_events_settlement ON cash_dispute_events(settlement_id) WHERE settlement_id IS NOT NULL;
CREATE FUNCTION protect_cash_dispute_settlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status='POSTED' AND NEW.status='VOIDED' AND EXISTS(SELECT 1 FROM cash_dispute_events WHERE settlement_id=OLD.id) THEN
  RAISE EXCEPTION 'dispute_settlement_dependency';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cash_dispute_settlement_dependency BEFORE UPDATE ON cash_settlements FOR EACH ROW EXECUTE FUNCTION protect_cash_dispute_settlement();

-- Recuperación del proveedor sumada a un depósito: neto = cobros − reembolsos − deducciones + recuperaciones.
ALTER TABLE cash_settlements ADD COLUMN recoveries numeric(12,2) NOT NULL DEFAULT 0 CHECK(recoveries>=0);
ALTER TABLE cash_settlements DROP CONSTRAINT cash_settlement_balance;
ALTER TABLE cash_settlements ADD CONSTRAINT cash_settlement_balance CHECK(gross-refunds-deductions+recoveries=net);
CREATE FUNCTION check_cash_dispute_settlement_links() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 -- Cada recuperación del total tiene su efecto, y un contracargo vinculado a su expediente lo está por su importe exacto.
 -- Un contracargo sin expediente (comandos cerrados) queda como deducción histórica: el expediente lo detecta y lo vincula después.
 IF NEW.recoveries<>coalesce((SELECT sum(principal) FROM cash_dispute_events WHERE settlement_id=NEW.id AND kind='PROVIDER_RECOVERY'),0)
  OR EXISTS(SELECT 1 FROM cash_settlement_deductions x JOIN cash_dispute_events e ON e.deduction_id=x.id AND e.settlement_id=NEW.id
   WHERE x.settlement_id=NEW.id AND x.kind='CHARGEBACK' AND (e.kind<>'PROVIDER_WITHHOLDING' OR e.principal<>x.amount)) THEN
  RAISE EXCEPTION 'dispute_settlement_links';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cash_dispute_settlement_links AFTER INSERT ON cash_settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_settlement_links();

-- Internal helpers are not a public RPC surface (including advisory lock helpers).
DO $$ DECLARE fn record; r record; BEGIN
 FOR fn IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace=current_schema()::regnamespace
  AND (proname LIKE 'cash_dispute_%' OR proname LIKE 'protect_cash_dispute%' OR proname LIKE 'check_cash_dispute%' OR proname LIKE 'assert_cash_dispute%' OR proname='protect_cash_payment_dispute') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',fn.signature,r.rolname);
  END LOOP;
 END LOOP;
END $$;


 INSERT INTO public._prisma_migrations(id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count) VALUES('3af46117-5a4f-46aa-8f9d-62a5607a1da8','41e05343b8c0cfd39456fc3c285025941256bbef2bb58f46eed18be2e351c5a7',clock_timestamp(),'20261122220100_cash_payment_disputes',NULL,NULL,clock_timestamp(),1);
 DO $$ DECLARE old record; e text; now_count bigint; now_hash text; BEGIN
 FOR old IN SELECT * FROM protected_baseline ORDER BY table_name LOOP
   e:=CASE WHEN old.table_name='cash_settlements' THEN 'to_jsonb(t)-''recoveries''' ELSE 'to_jsonb(t)' END;
   EXECUTE format('SELECT count(*),md5(coalesce(string_agg(md5((%s)::text),'''' ORDER BY md5((%s)::text)),'''')) FROM public.%I t %s',e,e,old.table_name,
     CASE WHEN old.table_name='_prisma_migrations' THEN 'WHERE migration_name NOT IN (''20261122220000_cash_dispute_sources'',''20261122220100_cash_payment_disputes'')' ELSE '' END) INTO now_count,now_hash;
   IF old.row_count<>now_count OR old.row_hash<>now_hash THEN RAISE EXCEPTION 'Preservation check failed for %',old.table_name; END IF;
 END LOOP;
 IF to_regclass('public.cash_settlements') IS NOT NULL AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cash_settlements' AND column_name='recoveries') THEN
   EXECUTE 'SELECT count(*) FROM public.cash_settlements WHERE recoveries<>0' INTO now_count;
   IF now_count<>0 THEN RAISE EXCEPTION 'Preservation check failed for cash_settlements.recoveries'; END IF;
 END IF;
 END $$;
 SELECT jsonb_build_object('name','20261122220100_cash_payment_disputes','preservedTableCount',count(*),'preservedRows',sum(row_count),'dataUnchanged',true) FROM protected_baseline;
 COMMIT;