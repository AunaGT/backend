-- Same transaction-scoped gate for opening and finalizing an operational day. No historical rows change.
CREATE FUNCTION cash_day_lock(company uuid,branch uuid,day date) RETURNS void LANGUAGE sql VOLATILE AS $$
 SELECT pg_advisory_xact_lock(hashtextextended('cash-day:'||company::text||':'||branch::text||':'||day::text,0));
$$;

CREATE FUNCTION protect_cash_day_opening() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_branch uuid; owner_company uuid;
BEGIN
 IF NEW.money_event_version<>1 THEN RETURN NEW; END IF;
 SELECT r.branch_id,b.company_id INTO owner_branch,owner_company FROM cash_registers r JOIN branches b ON b.id=r.branch_id WHERE r.id=NEW.cash_register_id;
 PERFORM cash_day_lock(owner_company,owner_branch,NEW.business_date);
 IF EXISTS(SELECT 1 FROM cash_daily_consolidations WHERE company_id=owner_company AND branch_id=owner_branch AND business_date=NEW.business_date) THEN
  RAISE EXCEPTION 'cash_day_closed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_cash_day_opening BEFORE INSERT ON cash_register_sessions FOR EACH ROW EXECUTE FUNCTION protect_cash_day_opening();

CREATE OR REPLACE FUNCTION protect_cash_daily_consolidation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'cash_day_immutable' USING ERRCODE='23514'; END IF;
 PERFORM cash_day_lock(NEW.company_id,NEW.branch_id,NEW.business_date);
 PERFORM 1 FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.cash_register_id
  WHERE r.branch_id=NEW.branch_id AND s.business_date=NEW.business_date AND s.money_event_version=1 FOR UPDATE OF s;
 IF EXISTS(SELECT 1 FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.cash_register_id
   WHERE r.branch_id=NEW.branch_id AND s.business_date=NEW.business_date AND s.money_event_version=1 AND s.status='OPEN') THEN
  RAISE EXCEPTION 'cash_day_open_turn' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.cash_register_id LEFT JOIN cash_closures c ON c.id=s.cash_closure_id
   WHERE r.branch_id=NEW.branch_id AND s.business_date=NEW.business_date AND s.money_event_version=1 AND (c.id IS NULL OR c.status IN('Pendiente','Reconteo'))) THEN
  RAISE EXCEPTION 'cash_day_pending' USING ERRCODE='23514'; END IF;
 NEW.finalized_at=clock_timestamp();
 RETURN NEW;
END $$;
