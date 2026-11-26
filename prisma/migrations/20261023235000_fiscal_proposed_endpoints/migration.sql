BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.fiscal_connector_versions ADD COLUMN endpoints jsonb NOT NULL DEFAULT '{}'::jsonb;
-- A URL-only draft may be prepared, then have its last URL explicitly removed.
-- Configuration presence is not readiness; credential/profile shape checks remain in place.
ALTER TABLE public.fiscal_connector_versions DROP CONSTRAINT fiscal_version_configuration_check;
ALTER TABLE public.fiscal_connector_versions ADD CONSTRAINT fiscal_proposed_endpoints_shape CHECK (
  jsonb_typeof(endpoints) = 'object' AND octet_length(endpoints::text) <= 16384
  AND endpoints - ARRAY['ISSUE','CREDIT_NOTE','CANCEL','LOOKUP'] = '{}'::jsonb
  AND (NOT endpoints ? 'ISSUE' OR COALESCE(jsonb_typeof(endpoints->'ISSUE') = 'string' AND length(endpoints->>'ISSUE') BETWEEN 1 AND 2048 AND endpoints->>'ISSUE' LIKE 'https://%', false))
  AND (NOT endpoints ? 'CREDIT_NOTE' OR COALESCE(jsonb_typeof(endpoints->'CREDIT_NOTE') = 'string' AND length(endpoints->>'CREDIT_NOTE') BETWEEN 1 AND 2048 AND endpoints->>'CREDIT_NOTE' LIKE 'https://%', false))
  AND (NOT endpoints ? 'CANCEL' OR COALESCE(jsonb_typeof(endpoints->'CANCEL') = 'string' AND length(endpoints->>'CANCEL') BETWEEN 1 AND 2048 AND endpoints->>'CANCEL' LIKE 'https://%', false))
  AND (NOT endpoints ? 'LOOKUP' OR COALESCE(jsonb_typeof(endpoints->'LOOKUP') = 'string' AND length(endpoints->>'LOOKUP') BETWEEN 1 AND 2048 AND endpoints->>'LOOKUP' LIKE 'https://%', false))
);
-- Existing table RLS/grants and the immutable-history trigger also protect the new column.
COMMIT;
