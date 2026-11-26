CREATE TYPE "CashRegisterType" AS ENUM ('PHYSICAL', 'VIRTUAL');
CREATE TYPE "CashRegisterOperationMode" AS ENUM ('INDIVIDUAL', 'SHARED');

ALTER TABLE cash_registers
  ADD COLUMN kind "CashRegisterType" NOT NULL DEFAULT 'PHYSICAL',
  ADD COLUMN operation_mode "CashRegisterOperationMode" NOT NULL DEFAULT 'INDIVIDUAL',
  ADD COLUMN currency_code varchar(3),
  ADD COLUMN revision integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT cash_register_currency_code_check CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT cash_register_virtual_currency_check CHECK (kind <> 'VIRTUAL' OR currency_code IS NOT NULL),
  ADD CONSTRAINT cash_register_revision_check CHECK (revision > 0);

-- NULL identifies legacy snapshots; currency and business date are never inferred.
ALTER TABLE cash_register_sessions
  ADD COLUMN register_type "CashRegisterType",
  ADD COLUMN operation_mode "CashRegisterOperationMode",
  ADD COLUMN currency_code varchar(3),
  ADD COLUMN business_date date,
  ADD COLUMN revision integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT cash_session_snapshot_complete_check CHECK (num_nonnulls(register_type,operation_mode,currency_code,business_date) IN (0,4)),
  ADD CONSTRAINT cash_session_currency_code_check CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT cash_session_virtual_float_check CHECK (register_type <> 'VIRTUAL' OR opening_float = 0),
  ADD CONSTRAINT cash_session_revision_check CHECK (revision > 0);

CREATE FUNCTION protect_cash_register_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.kind IS DISTINCT FROM OLD.kind OR NEW.currency_code IS DISTINCT FROM OLD.currency_code)
     AND EXISTS (SELECT 1 FROM cash_register_sessions WHERE cash_register_id=OLD.id) THEN
    RAISE EXCEPTION 'cash_register_identity_immutable: crea otra caja para cambiar tipo o moneda con historial' USING ERRCODE='23514';
  END IF;
  IF NEW.operation_mode IS DISTINCT FROM OLD.operation_mode
     AND EXISTS (SELECT 1 FROM cash_register_sessions WHERE cash_register_id=OLD.id AND status='OPEN') THEN
    RAISE EXCEPTION 'cash_register_mode_open: termina el turno antes de cambiar modalidad' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER protect_cash_register_identity
BEFORE UPDATE OF kind,currency_code,operation_mode ON cash_registers
FOR EACH ROW EXECUTE FUNCTION protect_cash_register_identity();

CREATE FUNCTION protect_cash_session_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE register_row record;
BEGIN
  IF TG_OP='UPDATE' AND OLD.register_type IS NOT NULL THEN
    IF (
       NEW.register_type IS DISTINCT FROM OLD.register_type OR NEW.operation_mode IS DISTINCT FROM OLD.operation_mode
       OR NEW.currency_code IS DISTINCT FROM OLD.currency_code OR NEW.business_date IS DISTINCT FROM OLD.business_date
       OR NEW.cash_register_id IS DISTINCT FROM OLD.cash_register_id OR NEW.opening_float IS DISTINCT FROM OLD.opening_float
       ) THEN
      RAISE EXCEPTION 'cash_session_snapshot_immutable: los datos declarados del turno no se modifican' USING ERRCODE='23514';
    END IF;
    -- A historical snapshot is compared with itself, not today's register mode.
    RETURN NEW;
  END IF;
  -- A real parent-row version prevents stale Repeatable Read configuration
  -- changes from missing a concurrently established session. Lock-only is insufficient.
  UPDATE cash_registers SET revision=revision+1 WHERE id=NEW.cash_register_id
    RETURNING kind,operation_mode,currency_code INTO register_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cash_session_register_missing' USING ERRCODE='23503';
  END IF;
  IF NEW.register_type IS NULL THEN
    IF register_row.kind='VIRTUAL' OR register_row.operation_mode='SHARED' THEN
      RAISE EXCEPTION 'cash_session_snapshot_required: esta caja exige declarar el snapshot completo' USING ERRCODE='23514';
    END IF;
  ELSIF register_row.currency_code IS NULL
     OR NEW.register_type IS DISTINCT FROM register_row.kind
     OR NEW.operation_mode IS DISTINCT FROM register_row.operation_mode
     OR NEW.currency_code IS DISTINCT FROM register_row.currency_code THEN
    RAISE EXCEPTION 'cash_session_register_mismatch: el turno no coincide con su caja' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER protect_cash_session_snapshot
BEFORE INSERT OR UPDATE OF cash_register_id,register_type,operation_mode,currency_code,business_date,opening_float ON cash_register_sessions
FOR EACH ROW EXECUTE FUNCTION protect_cash_session_snapshot();
