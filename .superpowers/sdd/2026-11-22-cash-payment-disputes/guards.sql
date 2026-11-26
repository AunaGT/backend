-- New documents only. Existing money, closures and settlements are never rewritten.
ALTER TABLE cash_payment_disputes ADD FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),
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
DECLARE e cash_money_events; customer uuid;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'dispute_immutable'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['status','version','won','lost'])<>(to_jsonb(OLD)-ARRAY['status','version','won','lost']) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'dispute_immutable'; END IF;
  IF (NEW.status,NEW.won,NEW.lost) IS DISTINCT FROM (OLD.status,OLD.won,OLD.lost) AND NOT EXISTS(SELECT 1 FROM cash_dispute_proposals WHERE dispute_id=OLD.id AND expected_version=OLD.version AND status='APPROVED') THEN RAISE EXCEPTION 'dispute_decision_required'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO e FROM cash_money_events WHERE id=NEW.event_id;
 IF e.id IS NULL OR e.company_id<>NEW.company_id OR e.branch_id<>NEW.branch_id OR e.payment_method_id<>NEW.payment_method_id OR e.currency_code<>NEW.currency_code OR e.direction<>'IN' OR e.settlement_kind<>'BANK' OR e.source_type NOT IN('SALE','CUSTOMER_PAYMENT') THEN RAISE EXCEPTION 'dispute_scope'; END IF;
 IF e.source_type='CUSTOMER_PAYMENT' THEN SELECT customer_id INTO customer FROM customer_payments WHERE id=e.source_id;
 ELSE SELECT customer_contact_id INTO customer FROM sales WHERE id=e.source_id; END IF;
 IF NEW.customer_id IS DISTINCT FROM customer THEN RAISE EXCEPTION 'dispute_scope'; END IF;
 IF NEW.status<>'OPEN' OR NEW.version<>1 OR NEW.won<>0 OR NEW.lost<>0 THEN RAISE EXCEPTION 'dispute_initial_state'; END IF;
 PERFORM cash_dispute_lock_origin(NEW.company_id,NEW.event_id);
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_payment_dispute BEFORE INSERT OR UPDATE OR DELETE ON cash_payment_disputes FOR EACH ROW EXECUTE FUNCTION protect_cash_payment_dispute();

CREATE FUNCTION check_cash_dispute_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid uuid; cid uuid; original numeric; refunded numeric:=0; used numeric;
BEGIN
 IF TG_TABLE_NAME='cash_payment_disputes' THEN eid:=NEW.event_id;cid:=NEW.company_id;
 ELSE SELECT event_id,company_id INTO eid,cid FROM cash_payment_disputes WHERE id=NEW.dispute_id; END IF;
 PERFORM cash_dispute_lock_origin(cid,eid);
 SELECT amount INTO original FROM cash_money_events WHERE id=eid;
 SELECT coalesce(sum(r.amount),0) INTO refunded FROM customer_payment_refunds r JOIN cash_money_events e ON e.source_id=r.payment_id AND e.source_type='CUSTOMER_PAYMENT' WHERE e.id=eid AND r.status='CONFIRMED';
 SELECT refunded+coalesce(sum(a.amount),0) INTO refunded FROM payment_allocation_events a JOIN cash_money_events e ON e.source_id=a.payment_id AND e.source_type='CUSTOMER_PAYMENT' WHERE e.id=eid AND a.action='SALE_REFUNDED';
 SELECT coalesce(sum(CASE WHEN d.status IN('OPEN','SUBMITTED') THEN d.claimed ELSE greatest(0,coalesce(x.exposure,0)) END),0) INTO used
 FROM cash_payment_disputes d LEFT JOIN LATERAL (SELECT sum(cash_dispute_effect_delta(ev.kind,r.kind,ev.principal)) AS exposure FROM cash_dispute_events ev LEFT JOIN cash_dispute_events r ON r.id=ev.reversal_of_id WHERE ev.dispute_id=d.id) x ON true WHERE d.event_id=eid;
 IF used+refunded>original THEN RAISE EXCEPTION 'dispute_coverage'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cash_dispute_coverage AFTER INSERT OR UPDATE ON cash_payment_disputes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_coverage();
CREATE CONSTRAINT TRIGGER cash_dispute_effect_coverage AFTER INSERT ON cash_dispute_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_coverage();

CREATE FUNCTION protect_cash_dispute_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d cash_payment_disputes; r cash_dispute_events; exposure numeric; used numeric;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'dispute_immutable'; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.journal_entry_id IS NOT NULL OR OLD.accounting_status<>'DEFERRED' OR NEW.journal_entry_id IS NULL OR NEW.accounting_status NOT IN('POSTED','INTEGRATED') OR (to_jsonb(NEW)-ARRAY['journal_entry_id','accounting_status'])<>(to_jsonb(OLD)-ARRAY['journal_entry_id','accounting_status']) THEN RAISE EXCEPTION 'dispute_immutable'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO d FROM cash_payment_disputes WHERE id=NEW.dispute_id;
 IF d.id IS NULL THEN RAISE EXCEPTION 'dispute_scope'; END IF;
 PERFORM cash_dispute_lock_origin(d.company_id,d.event_id);
 PERFORM 1 FROM cash_payment_disputes WHERE id=d.id FOR UPDATE;
 IF NEW.kind='COMPENSATION' THEN
  SELECT * INTO r FROM cash_dispute_events WHERE id=NEW.reversal_of_id;
  SELECT coalesce(sum(principal),0) INTO used FROM cash_dispute_events WHERE reversal_of_id=r.id;
  IF r.id IS NULL OR r.dispute_id<>d.id OR r.kind NOT IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING','BANK_RECOVERY','PROVIDER_RECOVERY') OR used+NEW.principal>r.principal THEN RAISE EXCEPTION 'dispute_compensation'; END IF;
 END IF;
 SELECT coalesce(sum(cash_dispute_effect_delta(e.kind,o.kind,e.principal)),0) INTO exposure FROM cash_dispute_events e LEFT JOIN cash_dispute_events o ON o.id=e.reversal_of_id WHERE e.dispute_id=d.id;
 exposure:=exposure+cash_dispute_effect_delta(NEW.kind,r.kind,NEW.principal);
 IF exposure<0 OR exposure>d.claimed THEN RAISE EXCEPTION 'dispute_effect_budget'; END IF;
 IF d.status='CANCELLED' AND NEW.kind NOT IN('COMMUNICATION','EVIDENCE') THEN RAISE EXCEPTION 'dispute_cancelled'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_dispute_event BEFORE INSERT OR UPDATE OR DELETE ON cash_dispute_events FOR EACH ROW EXECUTE FUNCTION protect_cash_dispute_event();

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
