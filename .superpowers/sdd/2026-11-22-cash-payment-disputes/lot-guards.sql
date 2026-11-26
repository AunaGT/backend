CREATE FUNCTION protect_cash_dispute_lot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d cash_payment_disputes; p cash_dispute_proposals; e cash_dispute_events; target cash_dispute_lots; used numeric; exposure numeric; disposed numeric; allowed numeric;
BEGIN
 SELECT * INTO d FROM cash_payment_disputes WHERE id=NEW.dispute_id;
 IF d.id IS NULL THEN RAISE EXCEPTION 'dispute_scope'; END IF;
 PERFORM cash_dispute_lock_origin(d.company_id,d.event_id);
 PERFORM 1 FROM cash_payment_disputes WHERE id=d.id FOR UPDATE;
 IF NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id AND company_id=d.company_id AND active AND NOT is_group) THEN RAISE EXCEPTION 'dispute_account_scope'; END IF;
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
  SELECT coalesce(sum(principal),0) INTO used FROM cash_dispute_lots WHERE target_lot_id=target.id AND kind IN('RECOVERED','COMPENSATED');
  IF used+NEW.principal>target.principal THEN RAISE EXCEPTION 'dispute_lot_budget'; END IF;
  IF NEW.kind='RECOVERED' THEN
   SELECT * INTO e FROM cash_dispute_events WHERE id=NEW.event_id AND dispute_id=d.id;
   SELECT coalesce(sum(principal),0) INTO used FROM cash_dispute_lots WHERE event_id=e.id AND kind='RECOVERED';
   IF e.id IS NULL OR e.kind NOT IN('BANK_RECOVERY','PROVIDER_RECOVERY') OR used+NEW.principal>e.principal THEN RAISE EXCEPTION 'dispute_recovery_source'; END IF;
  ELSE
   SELECT * INTO p FROM cash_dispute_proposals WHERE id=NEW.proposal_id AND dispute_id=d.id;
   IF p.id IS NULL OR p.status<>'APPROVED' OR p.kind NOT IN('FORGIVE','CORRECT','COMPENSATE') OR p.expected_version<>d.version THEN RAISE EXCEPTION 'dispute_proposal_required'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_cash_dispute_lot BEFORE INSERT ON cash_dispute_lots FOR EACH ROW EXECUTE FUNCTION protect_cash_dispute_lot();
