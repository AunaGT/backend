BEGIN;
CREATE TYPE "PaymentMethodSettlementKind" AS ENUM ('CASH','BANK','CREDIT');
ALTER TABLE payment_methods ADD COLUMN company_id UUID,
  ADD COLUMN base_code VARCHAR(20), ADD COLUMN settlement_kind "PaymentMethodSettlementKind";
ALTER TABLE payment_methods ADD CONSTRAINT payment_method_owner_fk
  FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE RESTRICT;
DROP INDEX payment_methods_name_key;
CREATE UNIQUE INDEX payment_methods_company_id_name_key ON payment_methods(company_id,name);
CREATE UNIQUE INDEX payment_methods_shared_name_key ON payment_methods(name) WHERE company_id IS NULL;
CREATE UNIQUE INDEX payment_methods_private_normalized_name_key
  ON payment_methods(company_id,lower(btrim(name))) WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX payment_methods_base_code_key ON payment_methods(base_code);
ALTER TABLE payment_methods ADD CONSTRAINT payment_method_kind_consistent
  CHECK(settlement_kind IS NULL OR is_credit=(settlement_kind='CREDIT'));
ALTER TABLE payment_methods ADD CONSTRAINT payment_method_private_kind
  CHECK(company_id IS NULL OR (settlement_kind IS NOT NULL AND base_code IS NULL));
CREATE TABLE company_payment_methods (
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  payment_method_id INTEGER NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  position INTEGER NOT NULL DEFAULT 0 CHECK(position>=0),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(company_id,payment_method_id)
);
CREATE INDEX company_payment_methods_company_id_enabled_position_idx
  ON company_payment_methods(company_id,enabled,position);
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM payment_methods GROUP BY lower(btrim(name)) HAVING count(*)>1) THEN
    RAISE EXCEPTION 'PM_SETUP_REQUIRED: shared names collide';
  END IF;
  IF EXISTS(SELECT 1 FROM payment_methods WHERE lower(btrim(name))='crédito' AND NOT is_credit)
    OR EXISTS(SELECT 1 FROM payment_methods WHERE lower(btrim(name)) IN ('efectivo','tarjeta','transferencia') AND is_credit) THEN
    RAISE EXCEPTION 'PM_SETUP_REQUIRED: basic classification contradicts existing data';
  END IF;
  IF EXISTS(SELECT 1 FROM payment_methods WHERE name<>btrim(name)
    AND lower(btrim(name)) IN ('efectivo','tarjeta','transferencia','crédito')) THEN
    RAISE EXCEPTION 'PM_SETUP_REQUIRED: noncanonical basic name needs review';
  END IF;
END $$;
UPDATE payment_methods SET base_code=CASE lower(btrim(name))
  WHEN 'efectivo' THEN 'CASH' WHEN 'tarjeta' THEN 'CARD'
  WHEN 'transferencia' THEN 'TRANSFER' WHEN 'crédito' THEN 'CREDIT' END,
  settlement_kind=CASE lower(btrim(name)) WHEN 'efectivo' THEN 'CASH'::"PaymentMethodSettlementKind"
  WHEN 'crédito' THEN 'CREDIT'::"PaymentMethodSettlementKind" ELSE 'BANK'::"PaymentMethodSettlementKind" END
WHERE lower(btrim(name)) IN ('efectivo','tarjeta','transferencia','crédito');
INSERT INTO payment_methods(name,is_credit,base_code,settlement_kind)
SELECT v.name,v.credit,v.code,v.kind::"PaymentMethodSettlementKind"
FROM (VALUES ('Efectivo',false,'CASH','CASH'),('Tarjeta',false,'CARD','BANK'),
 ('Transferencia',false,'TRANSFER','BANK'),('Crédito',true,'CREDIT','CREDIT')) v(name,credit,code,kind)
WHERE NOT EXISTS(SELECT 1 FROM payment_methods m WHERE m.base_code=v.code);
INSERT INTO company_payment_methods(company_id,payment_method_id,position)
SELECT c.id,m.id,(row_number() OVER(PARTITION BY c.id ORDER BY m.id)-1)::integer
FROM companies c CROSS JOIN payment_methods m WHERE m.company_id IS NULL;
CREATE FUNCTION guard_company_payment_method_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id UUID;
BEGIN
  SELECT company_id INTO owner_id FROM payment_methods WHERE id=NEW.payment_method_id;
  IF owner_id IS NOT NULL AND owner_id<>NEW.company_id THEN
    RAISE EXCEPTION 'Payment method belongs to another company' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_payment_method_owner_guard BEFORE INSERT OR UPDATE
 ON company_payment_methods FOR EACH ROW EXECUTE FUNCTION guard_company_payment_method_owner();

-- Fully covered Agenda receipts may be mixed; POS still requires a real method.
CREATE OR REPLACE FUNCTION guard_confirmed_sale_payment_method() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_method_id IS NULL
     AND EXISTS(SELECT 1 FROM sale_statuses WHERE id=NEW.status_id AND name='Completada')
     AND NOT (
       NEW.settlement_source='ENGAGEMENT_RECEIPTS'
       AND EXISTS(
         SELECT 1 FROM appointment_engagements e
         WHERE e.id=NEW.origin_engagement_id AND e.branch_id=NEW.branch_id
           AND e.customer_id=NEW.customer_contact_id
           AND NEW.adjusted_total <= COALESCE((
             SELECT sum(pc.amount) FROM payment_commitments pc
             WHERE pc.engagement_id=e.id AND pc.company_id=e.company_id
               AND pc.branch_id=e.branch_id AND pc.customer_id=e.customer_id
               AND pc.state IN ('COMMITTED','APPLIED')
           ),0)
       )
     ) THEN
    RAISE EXCEPTION 'Confirmed sales require a payment method or covered engagement receipts'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER confirmed_sale_payment_method_guard ON sales;
CREATE TRIGGER confirmed_sale_payment_method_guard BEFORE INSERT OR UPDATE ON sales
 FOR EACH ROW EXECUTE FUNCTION guard_confirmed_sale_payment_method();
COMMIT;
