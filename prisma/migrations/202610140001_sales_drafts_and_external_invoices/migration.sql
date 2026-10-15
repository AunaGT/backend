BEGIN;
ALTER TABLE sales ADD COLUMN origin_engagement_id UUID, ADD COLUMN version INTEGER NOT NULL DEFAULT 1, ADD COLUMN confirmed_at TIMESTAMP(3);
ALTER TABLE sales ALTER COLUMN payment_method_id DROP NOT NULL;
CREATE UNIQUE INDEX engagement_branch_id_key ON appointment_engagements(branch_id,id);
CREATE UNIQUE INDEX engagement_confirmed_origin_identity_key ON appointment_engagements(branch_id,id,sale_id);
CREATE UNIQUE INDEX sale_origin_engagement_key ON sales(origin_engagement_id);
CREATE UNIQUE INDEX sale_origin_branch_key ON sales(branch_id,origin_engagement_id);
CREATE UNIQUE INDEX sale_origin_identity_key ON sales(branch_id,origin_engagement_id,id);
UPDATE sales s SET origin_engagement_id=e.id FROM appointment_engagements e
WHERE e.sale_id=s.id AND e.branch_id=s.branch_id AND s.origin_engagement_id IS NULL;
UPDATE sales s SET confirmed_at=s.sold_at FROM sale_statuses st WHERE st.id=s.status_id AND st.name='Completada';
ALTER TABLE sales ADD CONSTRAINT sale_origin_branch_fk FOREIGN KEY(branch_id,origin_engagement_id) REFERENCES appointment_engagements(branch_id,id) ON DELETE RESTRICT;
ALTER TABLE appointment_engagements ADD CONSTRAINT engagement_confirmed_sale_origin_fk FOREIGN KEY(branch_id,id,sale_id) REFERENCES sales(branch_id,origin_engagement_id,id) ON DELETE RESTRICT;
INSERT INTO sale_statuses(name) VALUES ('Borrador') ON CONFLICT(name) DO NOTHING;
CREATE FUNCTION guard_confirmed_sale_payment_method() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_method_id IS NULL AND EXISTS(SELECT 1 FROM sale_statuses WHERE id=NEW.status_id AND name='Completada') THEN
    RAISE EXCEPTION 'Confirmed sales require a payment method' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER confirmed_sale_payment_method_guard BEFORE INSERT OR UPDATE OF payment_method_id,status_id ON sales FOR EACH ROW EXECUTE FUNCTION guard_confirmed_sale_payment_method();

ALTER TABLE sale_dtes ADD COLUMN company_id UUID, ADD COLUMN branch_id UUID;
UPDATE sale_dtes d SET branch_id=s.branch_id,company_id=b.company_id FROM sales s JOIN branches b ON b.id=s.branch_id WHERE s.id=d.sale_id;
ALTER TABLE sale_dtes ALTER COLUMN company_id SET NOT NULL, ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE sale_dtes ADD CONSTRAINT sale_dte_sale_branch_fk FOREIGN KEY(branch_id,sale_id) REFERENCES sales(branch_id,id) ON DELETE RESTRICT;
ALTER TABLE sale_dtes ADD CONSTRAINT sale_dte_company_branch_fk FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX sale_dte_company_authorization_key ON sale_dtes(company_id,lower(btrim("authorization"))) WHERE nullif(btrim("authorization"),'') IS NOT NULL;

CREATE TABLE sale_history (
  id UUID NOT NULL PRIMARY KEY,
  company_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  sale_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  action VARCHAR(40) NOT NULL,
  request_key VARCHAR(64) NOT NULL,
  input_hash VARCHAR(64) NOT NULL,
  "before" JSONB,
  "after" JSONB,
  reason TEXT,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sale_history_sale_branch_fk FOREIGN KEY(branch_id,sale_id) REFERENCES sales(branch_id,id) ON DELETE RESTRICT,
  CONSTRAINT sale_history_company_branch_fk FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id) ON DELETE RESTRICT,
  CONSTRAINT sale_history_actor_fk FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX sale_history_request_key ON sale_history(company_id,actor_id,action,request_key);
CREATE INDEX sale_history_sale_id_created_at_idx ON sale_history(sale_id,created_at);
COMMIT;
