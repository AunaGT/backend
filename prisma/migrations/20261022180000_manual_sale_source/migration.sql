BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.sales DROP CONSTRAINT sale_settlement_source_check;
ALTER TABLE public.sales ADD CONSTRAINT sale_settlement_source_check
 CHECK (settlement_source IN ('LEGACY','ENGAGEMENT_RECEIPTS','MANUAL_SALE'));
COMMIT;
