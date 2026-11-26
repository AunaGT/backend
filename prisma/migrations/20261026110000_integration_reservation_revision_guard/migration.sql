-- Independent legacy header/line FKs can point to different document owners.
-- Guard both; do not rewrite reservations or the already-applied migration.
CREATE OR REPLACE FUNCTION public.auna_reservation_revision_relation() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE document_ids UUID[]; line_document_ids UUID[]; old_line_id UUID; new_line_id UUID;
BEGIN
 IF TG_OP='INSERT' THEN
  document_ids=ARRAY[NEW.document_id];
  new_line_id=NEW.document_line_id;
 ELSIF TG_OP='DELETE' THEN
  document_ids=ARRAY[OLD.document_id];
  old_line_id=OLD.document_line_id;
 ELSE
  document_ids=ARRAY[OLD.document_id,NEW.document_id];
  old_line_id=OLD.document_line_id;
  new_line_id=NEW.document_line_id;
 END IF;
 -- Keep each line's owner stable while parent locks wait on other writers.
 SELECT array_agg(owners.document_id) INTO line_document_ids FROM (
  SELECT document_id FROM public.commercial_document_lines
   WHERE id IN (old_line_id,new_line_id) ORDER BY id FOR SHARE
 ) AS owners;
 PERFORM public.auna_touch_document_revisions(document_ids||COALESCE(line_document_ids,ARRAY[]::uuid[]));
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER document_revision_reservations ON public.stock_reservations;
CREATE TRIGGER document_revision_reservations BEFORE INSERT OR UPDATE OR DELETE ON public.stock_reservations FOR EACH ROW EXECUTE FUNCTION public.auna_reservation_revision_relation();
