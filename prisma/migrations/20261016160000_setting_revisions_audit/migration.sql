ALTER TABLE "system_settings" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" >= 1);

CREATE TABLE "setting_audit_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "key" VARCHAR(100) NOT NULL,
  "before_value" TEXT, "after_value" TEXT,
  "before_type" VARCHAR(50), "after_type" VARCHAR(50),
  "before_revision" INTEGER, "revision" INTEGER NOT NULL,
  "actor_id" UUID, "source" VARCHAR(80) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "setting_audit_events_company_id_created_at_id_idx" ON "setting_audit_events"("company_id", "created_at" DESC, "id");
CREATE INDEX "setting_audit_events_company_id_key_created_at_idx" ON "setting_audit_events"("company_id", "key", "created_at" DESC);
ALTER TABLE "setting_audit_events" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "setting_audit_events" FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION auna_setting_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN NEW.revision := 1;
  ELSIF NEW.value IS DISTINCT FROM OLD.value OR NEW.type IS DISTINCT FROM OLD.type THEN
    NEW.revision := OLD.revision + 1;
  ELSE NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER auna_setting_revision BEFORE INSERT OR UPDATE ON "system_settings"
FOR EACH ROW EXECUTE FUNCTION auna_setting_revision();

CREATE FUNCTION auna_audit_setting() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE setting_key TEXT; company UUID; actor UUID;
BEGIN
  setting_key := CASE WHEN TG_OP = 'DELETE' THEN OLD.key ELSE NEW.key END;
  IF setting_key <> ALL (ARRAY[
    'currency_code','currency_name','timezone','company_name','company_logo_url',
    'company_nit','company_address','company_municipality','company_department','company_postal_code',
    'establishment_code','vat_affiliation','iva_rate','pequeno_rate','fel_enabled','date_format','locale',
    'cash_closure_denominations','cash_closure_max_diff_pct','quote_validity_days','order_validity_days','quote_soft_hold_hours',
    'default_experience_profile','sales_allow_credit','sales_show_fiscal_fields','sales_show_channels','inventory_services_enabled',
    'returns.policy','inventory.expiry_alert_policy','payroll.rates','payroll.rates.baseline',
    'accounting.defaultAccounts','inventory.barcode_label_layout','inventory.shelf_price_label_layout'
  ]) THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.value IS NOT DISTINCT FROM OLD.value AND NEW.type IS NOT DISTINCT FROM OLD.type THEN RETURN NULL; END IF;
  company := CASE WHEN TG_OP = 'DELETE' THEN OLD.company_id ELSE NEW.company_id END;
  -- Company cascade deletion must not recreate orphan events.
  IF NOT EXISTS(SELECT 1 FROM companies WHERE id = company) THEN RETURN NULL; END IF;
  BEGIN actor := NULLIF(current_setting('auna.settings_actor', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN actor := NULL; END;
  INSERT INTO setting_audit_events(company_id,key,before_value,after_value,before_type,after_type,before_revision,revision,actor_id,source)
  VALUES(company,setting_key,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.value END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.value END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.type END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.type END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.revision END,
    CASE WHEN TG_OP = 'DELETE' THEN OLD.revision + 1 ELSE NEW.revision END,
    actor,LEFT(COALESCE(NULLIF(current_setting('auna.settings_source', true), ''),'system'),80));
  RETURN NULL;
END;
$$;
CREATE TRIGGER auna_audit_setting AFTER INSERT OR UPDATE OR DELETE ON "system_settings"
FOR EACH ROW EXECUTE FUNCTION auna_audit_setting();
