-- Cajas 5: consolidación diaria por sucursal y fecha operativa. Solo guarda la instantánea del día; no mueve dinero ni crea asientos.
CREATE TABLE cash_daily_consolidations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,branch_id uuid NOT NULL,
 business_date date NOT NULL,content_hash varchar(64) NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),snapshot jsonb NOT NULL,
 finalized_by_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,finalized_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id) ON DELETE RESTRICT,
 UNIQUE(company_id,branch_id,business_date)
);

-- Un día se finaliza sin turnos operando ni arqueos sin finalizar; lo finalizado no se edita ni se borra.
CREATE FUNCTION protect_cash_daily_consolidation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'cash_day_immutable' USING ERRCODE='23514'; END IF;
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
CREATE TRIGGER protect_cash_daily_consolidation BEFORE INSERT OR UPDATE OR DELETE ON cash_daily_consolidations FOR EACH ROW EXECUTE FUNCTION protect_cash_daily_consolidation();

-- Defensa: ningún rol cliente accede a las tablas de 4B ni a la consolidación (4B no traía este REVOKE explícito).
DO $$ DECLARE client_role text; t text; BEGIN
 FOREACH t IN ARRAY ARRAY['cash_bank_method_versions','cash_bank_method_settings','cash_bank_event_modes','cash_bank_deposits','cash_settlements','cash_settlement_allocations','cash_settlement_deductions','cash_daily_consolidations'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',t);
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',t,client_role); END IF;
  END LOOP;
 END LOOP;
END $$;
-- Fin defensa
