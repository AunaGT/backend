BEGIN;
ALTER TABLE sale_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sale_history FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON sale_history FROM anon;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON sale_history FROM authenticated;
  END IF;
END;
$$;
COMMIT;
