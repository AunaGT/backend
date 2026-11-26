CREATE TABLE integration_identities (
 id UUID PRIMARY KEY, company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(company_id,id)
);
ALTER TABLE payment_terms ADD CONSTRAINT payment_terms_company_id_id_key UNIQUE(company_id,id);
ALTER TABLE integration_credentials
 ADD COLUMN integration_id UUID,
 ADD COLUMN customer_policy VARCHAR(24) NOT NULL DEFAULT 'EXISTING_ONLY',
 ADD COLUMN customer_payment_term_id INTEGER;
-- Each previous key remains independent, including historical replacements.
INSERT INTO integration_identities(id,company_id,created_at) SELECT id,company_id,created_at FROM integration_credentials;
UPDATE integration_credentials SET integration_id=id;
ALTER TABLE integration_credentials
 ALTER COLUMN integration_id SET NOT NULL,
 ADD CONSTRAINT integration_credentials_company_id_integration_id_fkey FOREIGN KEY(company_id,integration_id) REFERENCES integration_identities(company_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT integration_credentials_customer_term_fkey FOREIGN KEY(company_id,customer_payment_term_id) REFERENCES payment_terms(company_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT integration_credentials_company_id_integration_id_id_key UNIQUE(company_id,integration_id,id),
 DROP CONSTRAINT integration_credentials_scopes_check,
 ADD CONSTRAINT integration_credentials_scopes_check CHECK(cardinality(scopes) BETWEEN 1 AND 9 AND scopes <@ ARRAY['products.read','categories.read','prices.read','availability.read','quotes.read','quotes.create_draft','orders.read','orders.create_draft','customers.create']::text[]),
 ADD CONSTRAINT integration_credentials_customer_policy_check CHECK(
  (customer_policy='EXISTING_ONLY' AND customer_payment_term_id IS NULL AND NOT ('customers.create'=ANY(scopes))) OR
  (customer_policy='CREATE_IF_MISSING' AND customer_payment_term_id IS NOT NULL AND 'customers.create'=ANY(scopes) AND scopes && ARRAY['quotes.create_draft','orders.create_draft']::text[])
 );
CREATE TABLE integration_customer_references (
 company_id UUID NOT NULL, integration_id UUID NOT NULL, external_id VARCHAR(100) NOT NULL,
 customer_id UUID NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(company_id,integration_id,external_id),
 FOREIGN KEY(company_id,integration_id) REFERENCES integration_identities(company_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(company_id,customer_id) REFERENCES suppliers(company_id,id) ON DELETE RESTRICT,
 CHECK(length(btrim(external_id)) BETWEEN 1 AND 100 AND external_id !~ '[[:cntrl:]]')
);
CREATE INDEX integration_customer_references_company_id_customer_id_idx ON integration_customer_references(company_id,customer_id);
CREATE INDEX suppliers_company_customer_normalized_tax_idx ON suppliers(company_id,upper(btrim(tax_id))) WHERE party_type='CUSTOMER';
CREATE TABLE integration_draft_operations (
 id UUID PRIMARY KEY, company_id UUID NOT NULL, integration_id UUID NOT NULL, credential_id UUID NOT NULL,
 branch_id UUID NOT NULL, document_id UUID NOT NULL UNIQUE,
 type VARCHAR(5) NOT NULL CHECK(type IN ('QUOTE','ORDER')),
 request_key VARCHAR(100) NOT NULL CHECK(request_key ~ '^[A-Za-z0-9._:-]{16,100}$'),
 input_hash VARCHAR(64) NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'),
 receipt JSONB NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=4096),
 currency_code VARCHAR(3) NOT NULL CHECK(currency_code ~ '^[A-Z]{3}$'),
 external_reference VARCHAR(100), created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(company_id,integration_id,type,request_key),
 UNIQUE(branch_id,document_id),
 FOREIGN KEY(company_id,integration_id,credential_id) REFERENCES integration_credentials(company_id,integration_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(branch_id,document_id) REFERENCES commercial_documents(branch_id,id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX integration_draft_operations_company_id_integration_id_type__idx ON integration_draft_operations(company_id,integration_id,type,document_id);
ALTER TABLE integration_audit_events DROP CONSTRAINT integration_audit_events_action_check,
 ADD CONSTRAINT integration_audit_events_action_check CHECK(action IN ('CREATE','REPLACE','REVOKE','USE','CREATE_DRAFT'));
ALTER TABLE integration_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_customer_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_draft_operations ENABLE ROW LEVEL SECURITY;
