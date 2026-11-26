-- Additive only: old grants and original creation receipts are unchanged.
ALTER TABLE public.integration_credentials DROP CONSTRAINT integration_credentials_scopes_check,
 ADD CONSTRAINT integration_credentials_scopes_check CHECK(
  cardinality(scopes) BETWEEN 1 AND 13 AND scopes <@ ARRAY['products.read','categories.read','prices.read','availability.read','quotes.read','quotes.create_draft','quotes.update_draft','quotes.cancel_draft','orders.read','orders.create_draft','orders.update_draft','orders.cancel_draft','customers.create']::text[]
  AND (NOT (scopes && ARRAY['quotes.update_draft','quotes.cancel_draft']::text[]) OR 'quotes.read'=ANY(scopes))
  AND (NOT (scopes && ARRAY['orders.update_draft','orders.cancel_draft']::text[]) OR 'orders.read'=ANY(scopes))
 );
ALTER TABLE public.integration_audit_events DROP CONSTRAINT integration_audit_events_action_check,
 ADD CONSTRAINT integration_audit_events_action_check CHECK(action IN ('CREATE','REPLACE','REVOKE','PAUSE','RESUME','USE','CREATE_DRAFT','UPDATE_DRAFT','CANCEL_DRAFT'));
ALTER TABLE public.integration_draft_operations ADD CONSTRAINT integration_draft_operations_origin_key UNIQUE(company_id,integration_id,document_id);
CREATE TABLE public.integration_draft_mutations (
 id UUID PRIMARY KEY, company_id UUID NOT NULL, integration_id UUID NOT NULL, credential_id UUID NOT NULL,
 branch_id UUID NOT NULL, document_id UUID NOT NULL,
 action VARCHAR(12) NOT NULL CHECK(action IN ('UPDATE_DRAFT','CANCEL_DRAFT')),
 request_key VARCHAR(100) NOT NULL CHECK(request_key ~ '^[A-Za-z0-9._:-]{16,100}$'),
 input_hash VARCHAR(64) NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'),
 receipt JSONB NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=4096),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(company_id,integration_id,document_id,action,request_key),
 FOREIGN KEY(company_id,integration_id,credential_id) REFERENCES public.integration_credentials(company_id,integration_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(company_id,branch_id) REFERENCES public.branches(company_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(company_id,integration_id,document_id) REFERENCES public.integration_draft_operations(company_id,integration_id,document_id) ON DELETE RESTRICT,
 FOREIGN KEY(branch_id,document_id) REFERENCES public.commercial_documents(branch_id,id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE public.integration_draft_mutations ENABLE ROW LEVEL SECURITY;

-- Public concurrency token, never derived from notes/PII and never a credential.
ALTER TABLE public.commercial_documents ADD COLUMN integration_revision UUID NOT NULL DEFAULT gen_random_uuid();

-- One lock order for OLD/NEW parents. Header updates below only rotate revision;
-- they do not change updated_at, business fields or stock.
CREATE FUNCTION public.auna_touch_document_revisions(document_ids UUID[]) RETURNS void
 LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE document_id UUID;
BEGIN
 FOR document_id IN SELECT DISTINCT id FROM unnest(document_ids) AS ids(id) WHERE id IS NOT NULL ORDER BY id LOOP
  UPDATE public.commercial_documents SET integration_revision=gen_random_uuid() WHERE id=document_id;
 END LOOP;
END;
$$;

CREATE FUNCTION public.auna_document_revision_header() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  PERFORM public.auna_touch_document_revisions(ARRAY[OLD.converted_from_id]);
  RETURN OLD;
 END IF;
 NEW.integration_revision=gen_random_uuid();
 IF TG_OP='INSERT' THEN
  PERFORM public.auna_touch_document_revisions(ARRAY[NEW.converted_from_id]);
 ELSIF OLD.converted_from_id IS DISTINCT FROM NEW.converted_from_id THEN
  PERFORM public.auna_touch_document_revisions(ARRAY[OLD.converted_from_id,NEW.converted_from_id]);
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER commercial_document_revision_header BEFORE INSERT OR UPDATE OR DELETE ON public.commercial_documents FOR EACH ROW EXECUTE FUNCTION public.auna_document_revision_header();

-- to_jsonb is only used for the fixed table/column allowlist below; no dynamic SQL.
CREATE FUNCTION public.auna_document_revision_relation() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE old_row JSONB; new_row JSONB; document_ids UUID[];
BEGIN
 IF TG_OP<>'INSERT' THEN old_row=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN new_row=to_jsonb(NEW); END IF;
 IF TG_TABLE_NAME IN ('commercial_document_lines','stock_reservations','commercial_document_sales','order_deliveries') THEN
  document_ids=ARRAY[(old_row->>'document_id')::uuid,(new_row->>'document_id')::uuid];
 ELSIF TG_TABLE_NAME='order_delivery_lines' THEN
  SELECT array_agg(document_id) INTO document_ids FROM public.commercial_document_lines
   WHERE id IN ((old_row->>'document_line_id')::uuid,(new_row->>'document_line_id')::uuid);
 ELSIF TG_TABLE_NAME='appointment_engagements' THEN
  document_ids=ARRAY[(old_row->>'quote_id')::uuid,(old_row->>'order_id')::uuid,(new_row->>'quote_id')::uuid,(new_row->>'order_id')::uuid];
 ELSIF TG_TABLE_NAME='appointment_engagement_lines' THEN
  document_ids=ARRAY[(old_row->>'source_document_id')::uuid,(new_row->>'source_document_id')::uuid];
 ELSE
  RAISE EXCEPTION 'Unsupported document revision relation';
 END IF;
 PERFORM public.auna_touch_document_revisions(document_ids);
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER document_revision_lines BEFORE INSERT OR UPDATE OR DELETE ON public.commercial_document_lines FOR EACH ROW EXECUTE FUNCTION public.auna_document_revision_relation();
CREATE TRIGGER document_revision_reservations BEFORE INSERT OR UPDATE OR DELETE ON public.stock_reservations FOR EACH ROW EXECUTE FUNCTION public.auna_document_revision_relation();
CREATE TRIGGER document_revision_sales BEFORE INSERT OR UPDATE OR DELETE ON public.commercial_document_sales FOR EACH ROW EXECUTE FUNCTION public.auna_document_revision_relation();
CREATE TRIGGER document_revision_deliveries BEFORE INSERT OR UPDATE OR DELETE ON public.order_deliveries FOR EACH ROW EXECUTE FUNCTION public.auna_document_revision_relation();
CREATE TRIGGER document_revision_delivery_lines BEFORE INSERT OR UPDATE OR DELETE ON public.order_delivery_lines FOR EACH ROW EXECUTE FUNCTION public.auna_document_revision_relation();
CREATE TRIGGER document_revision_engagements BEFORE INSERT OR UPDATE OR DELETE ON public.appointment_engagements FOR EACH ROW EXECUTE FUNCTION public.auna_document_revision_relation();
CREATE TRIGGER document_revision_engagement_lines BEFORE INSERT OR UPDATE OR DELETE ON public.appointment_engagement_lines FOR EACH ROW EXECUTE FUNCTION public.auna_document_revision_relation();
