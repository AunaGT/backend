BEGIN;

ALTER TABLE public.commercial_documents ADD COLUMN event_payment_terms jsonb;
ALTER TABLE public.sales ADD COLUMN event_payment_terms jsonb;
ALTER TABLE public.appointment_engagements ADD COLUMN event_payment_terms jsonb;
ALTER TABLE public.appointment_engagements ADD COLUMN event_payment_reference jsonb;

CREATE FUNCTION public.valid_event_payment_terms(v jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF v IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(v)<>'object' OR octet_length(v::text)>2048
    OR NOT (v ?& ARRAY['schemaVersion','depositPercent','balanceDaysBefore','referenceStartsAt','referenceTimezone','basisTotal','currencyCode'])
    OR v - ARRAY['schemaVersion','depositPercent','balanceDaysBefore','referenceStartsAt','referenceTimezone','basisTotal','currencyCode'] <> '{}'::jsonb
    OR v->'schemaVersion'<>'1'::jsonb
    OR jsonb_typeof(v->'depositPercent')<>'string' OR (v->>'depositPercent')!~'^\d{1,3}(\.\d{1,2})?$'
    OR (v->>'depositPercent')::numeric>100
    OR jsonb_typeof(v->'balanceDaysBefore')<>'number' OR (v->>'balanceDaysBefore')!~'^(0|[1-9][0-9]{0,2})$'
    OR (v->>'balanceDaysBefore')::integer>365
    OR jsonb_typeof(v->'basisTotal')<>'string' OR (v->>'basisTotal')!~'^\d{1,10}(\.\d{1,2})?$'
    OR (v->>'basisTotal')::numeric>=10000000000
    OR jsonb_typeof(v->'currencyCode')<>'string' OR (v->>'currencyCode')!~'^[A-Z]{3}$'
    OR jsonb_typeof(v->'referenceStartsAt')<>'string' OR length(v->>'referenceStartsAt')>40
    OR (v->>'referenceStartsAt')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$'
    OR jsonb_typeof(v->'referenceTimezone')<>'string'
    OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=v->>'referenceTimezone')
  THEN RETURN false; END IF;
  PERFORM (v->>'referenceStartsAt')::timestamptz;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION public.valid_event_payment_reference(v jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF v IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(v)<>'object' OR octet_length(v::text)>512 OR NOT (v ?& ARRAY['startsAt','timezone'])
    OR v-ARRAY['startsAt','timezone']<>'{}'::jsonb OR jsonb_typeof(v->'startsAt')<>'string' OR length(v->>'startsAt')>40
    OR (v->>'startsAt')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$'
    OR jsonb_typeof(v->'timezone')<>'string' OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=v->>'timezone')
  THEN RETURN false; END IF;
  PERFORM (v->>'startsAt')::timestamptz;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

ALTER TABLE public.commercial_documents ADD CONSTRAINT commercial_documents_event_payment_terms_check CHECK (public.valid_event_payment_terms(event_payment_terms));
ALTER TABLE public.sales ADD CONSTRAINT sales_event_payment_terms_check CHECK (public.valid_event_payment_terms(event_payment_terms));
ALTER TABLE public.appointment_engagements ADD CONSTRAINT appointment_engagements_event_payment_terms_check CHECK (public.valid_event_payment_terms(event_payment_terms));
ALTER TABLE public.appointment_engagements ADD CONSTRAINT appointment_engagements_event_payment_reference_check CHECK
  (public.valid_event_payment_reference(event_payment_reference) AND (event_payment_reference IS NULL OR event_payment_terms IS NOT NULL));

CREATE FUNCTION public.protect_event_payment_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_payment_terms IS DISTINCT FROM OLD.event_payment_terms
    AND (TG_TABLE_NAME <> 'commercial_documents' OR to_jsonb(OLD)->>'status' <> 'DRAFT') THEN
    RAISE EXCEPTION 'Use a new agreement to change accepted event payment terms' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commercial_documents_protect_event_payment_terms BEFORE UPDATE ON public.commercial_documents FOR EACH ROW EXECUTE FUNCTION public.protect_event_payment_terms();
CREATE TRIGGER sales_protect_event_payment_terms BEFORE UPDATE ON public.sales FOR EACH ROW EXECUTE FUNCTION public.protect_event_payment_terms();
CREATE TRIGGER appointment_engagements_protect_event_payment_terms BEFORE UPDATE ON public.appointment_engagements FOR EACH ROW EXECUTE FUNCTION public.protect_event_payment_terms();

COMMIT;
