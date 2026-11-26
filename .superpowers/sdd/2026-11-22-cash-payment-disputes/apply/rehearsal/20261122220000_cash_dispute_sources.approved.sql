BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='90s'; SET LOCAL TIME ZONE 'UTC'; SET LOCAL search_path=public;
 SELECT pg_advisory_xact_lock(910020,192202);
 CREATE TEMP TABLE protected_baseline(table_name text,row_count bigint,row_hash text) ON COMMIT DROP;
 DO $$ DECLARE n text; e text; BEGIN
 FOR n IN SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename LOOP
   e:=CASE WHEN n='cash_settlements' THEN 'to_jsonb(t)-''recoveries''' ELSE 'to_jsonb(t)' END;
   EXECUTE format('LOCK TABLE public.%I IN SHARE MODE',n);
   EXECUTE format('INSERT INTO protected_baseline SELECT %L,count(*),md5(coalesce(string_agg(md5((%s)::text),'''' ORDER BY md5((%s)::text)),'''')) FROM public.%I t %s',n,e,e,n,
     CASE WHEN n='_prisma_migrations' THEN 'WHERE migration_name NOT IN (''20261122220000_cash_dispute_sources'',''20261122220100_cash_payment_disputes'')' ELSE '' END);
 END LOOP;
 END $$;
 -- Confirm this enum-only migration before applying the following DDL.
ALTER TYPE "JournalSourceType" ADD VALUE IF NOT EXISTS 'CASH_DISPUTE_EFFECT';
ALTER TYPE "JournalSourceType" ADD VALUE IF NOT EXISTS 'CASH_DISPUTE_DISPOSITION';
ALTER TYPE "JournalSourceType" ADD VALUE IF NOT EXISTS 'CASH_DISPUTE_ADJUSTMENT';

 INSERT INTO public._prisma_migrations(id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count) VALUES('b608dcf8-4d22-4b42-932a-417bdf14190d','2324ed0e28ce0875e7f128f5dcfd0e73a6aef7fbc607d9999568da43eccb0fba',clock_timestamp(),'20261122220000_cash_dispute_sources',NULL,NULL,clock_timestamp(),1);
 DO $$ DECLARE old record; e text; now_count bigint; now_hash text; BEGIN
 FOR old IN SELECT * FROM protected_baseline ORDER BY table_name LOOP
   e:=CASE WHEN old.table_name='cash_settlements' THEN 'to_jsonb(t)-''recoveries''' ELSE 'to_jsonb(t)' END;
   EXECUTE format('SELECT count(*),md5(coalesce(string_agg(md5((%s)::text),'''' ORDER BY md5((%s)::text)),'''')) FROM public.%I t %s',e,e,old.table_name,
     CASE WHEN old.table_name='_prisma_migrations' THEN 'WHERE migration_name NOT IN (''20261122220000_cash_dispute_sources'',''20261122220100_cash_payment_disputes'')' ELSE '' END) INTO now_count,now_hash;
   IF old.row_count<>now_count OR old.row_hash<>now_hash THEN RAISE EXCEPTION 'Preservation check failed for %',old.table_name; END IF;
 END LOOP;
 IF to_regclass('public.cash_settlements') IS NOT NULL AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cash_settlements' AND column_name='recoveries') THEN
   EXECUTE 'SELECT count(*) FROM public.cash_settlements WHERE recoveries<>0' INTO now_count;
   IF now_count<>0 THEN RAISE EXCEPTION 'Preservation check failed for cash_settlements.recoveries'; END IF;
 END IF;
 END $$;
 SELECT jsonb_build_object('name','20261122220000_cash_dispute_sources','preservedTableCount',count(*),'preservedRows',sum(row_count),'dataUnchanged',true) FROM protected_baseline;
 COMMIT;