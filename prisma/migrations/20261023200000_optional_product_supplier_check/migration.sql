-- The API permits physical products without a habitual supplier. The previous
-- CHECK still required one. Keep the service, kit and precision invariants.
-- NOT VALID preserves the previous rollout policy for historical rows while
-- continuing to enforce this constraint on every inserted or updated row.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.products DROP CONSTRAINT products_service_fields_check;
ALTER TABLE public.products ADD CONSTRAINT products_service_fields_check CHECK (
  quantity_decimals BETWEEN 0 AND 6
  AND CASE WHEN kind = 'SERVICE' THEN
    quantity_decimals <= 4 AND supplier_id IS NULL AND stock = 0 AND min_stock = 0
    AND cost = 0 AND NOT tracks_expiry AND NOT stock_assembled
    AND service_unit_label IS NOT NULL AND length(btrim(service_unit_label)) BETWEEN 1 AND 50
  ELSE
    service_unit_label IS NULL
    AND (kind <> 'KIT' OR quantity_decimals = 0)
  END
) NOT VALID;

COMMIT;
