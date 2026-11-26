CREATE FUNCTION check_cash_dispute_child_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d cash_payment_disputes; l cash_dispute_lots; e cash_money_events;
BEGIN
 SELECT * INTO d FROM cash_payment_disputes WHERE id=NEW.dispute_id;
 IF d.id IS NULL OR d.company_id<>NEW.company_id OR d.branch_id<>NEW.branch_id OR d.customer_id IS DISTINCT FROM NEW.customer_id THEN RAISE EXCEPTION 'dispute_scope'; END IF;
 IF TG_TABLE_NAME='customer_receipt_restrictions' THEN
  SELECT * INTO e FROM cash_money_events WHERE id=d.event_id;
  IF e.source_type<>'CUSTOMER_PAYMENT' OR e.source_id<>NEW.payment_id THEN RAISE EXCEPTION 'dispute_scope'; END IF;
  IF TG_OP='UPDATE' AND ((NEW.payment_id,NEW.dispute_id,NEW.company_id,NEW.branch_id,NEW.customer_id) IS DISTINCT FROM (OLD.payment_id,OLD.dispute_id,OLD.company_id,OLD.branch_id,OLD.customer_id) OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'dispute_immutable'; END IF;
 ELSE
  SELECT * INTO l FROM cash_dispute_lots WHERE id=NEW.lot_id;
  IF l.id IS NULL OR l.dispute_id<>d.id OR NEW.currency_code<>d.currency_code THEN RAISE EXCEPTION 'dispute_scope'; END IF;
  IF TG_TABLE_NAME='customer_dispute_charges' AND (l.kind<>'CUSTOMER_CHARGE' OR l.principal<>NEW.amount) THEN RAISE EXCEPTION 'dispute_charge_source'; END IF;
  IF TG_TABLE_NAME='customer_recovery_credits' AND (l.kind<>'RECOVERED' OR l.principal<NEW.amount OR l.event_id IS DISTINCT FROM NEW.event_id) THEN RAISE EXCEPTION 'dispute_credit_source'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cash_dispute_restriction_scope BEFORE INSERT OR UPDATE ON customer_receipt_restrictions FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_child_scope();
CREATE TRIGGER cash_dispute_charge_scope BEFORE INSERT ON customer_dispute_charges FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_child_scope();
CREATE TRIGGER cash_dispute_credit_scope BEFORE INSERT ON customer_recovery_credits FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_child_scope();
CREATE FUNCTION assert_cash_dispute_receipt_budget(pid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE received numeric; applied numeric; committed numeric; refunded numeric; restricted numeric; charged numeric;
BEGIN
 SELECT amount INTO received FROM customer_payments WHERE id=pid;
 IF received IS NULL THEN RETURN; END IF;
 SELECT coalesce(sum(amount),0) INTO applied FROM sale_payment_entries WHERE customer_payment_id=pid;
 SELECT coalesce(sum(amount),0) INTO committed FROM payment_commitments WHERE payment_id=pid AND state='COMMITTED';
 SELECT coalesce(sum(amount),0) INTO refunded FROM (SELECT amount FROM customer_payment_refunds WHERE payment_id=pid AND status='CONFIRMED' UNION ALL SELECT amount FROM payment_allocation_events WHERE payment_id=pid AND action='SALE_REFUNDED') x;
 SELECT coalesce(sum(held+retired),0) INTO restricted FROM customer_receipt_restrictions WHERE payment_id=pid;
 SELECT coalesce(sum(CASE action WHEN 'APPLY' THEN amount ELSE -amount END),0) INTO charged FROM customer_dispute_charge_applications WHERE payment_id=pid;
 IF charged<0 OR applied+committed+refunded+restricted+charged>received THEN RAISE EXCEPTION 'dispute_receipt_budget'; END IF;
END $$;
CREATE FUNCTION check_cash_dispute_receipt_budget() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM assert_cash_dispute_receipt_budget(NEW.payment_id); RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cash_dispute_receipt_budget AFTER INSERT OR UPDATE ON customer_receipt_restrictions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_receipt_budget();
CREATE CONSTRAINT TRIGGER cash_dispute_receipt_application_budget AFTER INSERT ON customer_dispute_charge_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_dispute_receipt_budget();
CREATE FUNCTION protect_cash_dispute_restriction_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'dispute_immutable'; END $$;
CREATE TRIGGER cash_dispute_restriction_delete BEFORE DELETE ON customer_receipt_restrictions FOR EACH ROW EXECUTE FUNCTION protect_cash_dispute_restriction_delete();
