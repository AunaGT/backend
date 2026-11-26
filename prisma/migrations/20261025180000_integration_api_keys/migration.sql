CREATE TABLE integration_credentials (
 id UUID PRIMARY KEY, company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 owner_id UUID NOT NULL, created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 name VARCHAR(100) NOT NULL, public_id VARCHAR(32) NOT NULL UNIQUE,
 secret_hash VARCHAR(64) NOT NULL CHECK(secret_hash ~ '^[0-9a-f]{64}$'),
 scopes TEXT[] NOT NULL CHECK(cardinality(scopes) BETWEEN 1 AND 4 AND scopes <@ ARRAY['products.read','categories.read','prices.read','availability.read']::text[]),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMP(3) NOT NULL,
 revoked_at TIMESTAMP(3), last_used_at TIMESTAMP(3), replaces_id UUID,
 UNIQUE(company_id,id), FOREIGN KEY(owner_id,company_id) REFERENCES user_companies(user_id,company_id) ON DELETE RESTRICT,
 FOREIGN KEY(company_id,replaces_id) REFERENCES integration_credentials(company_id,id) ON DELETE RESTRICT,
 CHECK(expires_at>created_at AND expires_at<=created_at+INTERVAL '365 days')
);
CREATE INDEX integration_credentials_company_id_created_at_id_idx ON integration_credentials(company_id,created_at,id);
CREATE TABLE integration_credential_branches (
 company_id UUID NOT NULL, credential_id UUID NOT NULL, branch_id UUID NOT NULL,
 PRIMARY KEY(company_id,credential_id,branch_id),
 FOREIGN KEY(company_id,credential_id) REFERENCES integration_credentials(company_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE integration_audit_events (
 id UUID PRIMARY KEY, company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 credential_id UUID NOT NULL, actor_id UUID, branch_id UUID,
 action VARCHAR(16) NOT NULL CHECK(action IN ('CREATE','REPLACE','REVOKE','USE')),
 route VARCHAR(60), status INTEGER, request_id UUID, metadata JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(company_id,credential_id) REFERENCES integration_credentials(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX integration_audit_events_company_id_credential_id_created_at_i_idx ON integration_audit_events(company_id,credential_id,created_at,id);
CREATE INDEX integration_audit_events_action_created_at_id_idx ON integration_audit_events(action,created_at,id);
CREATE TABLE integration_rate_windows (
 bucket VARCHAR(80) NOT NULL, window_at TIMESTAMP(3) NOT NULL, count INTEGER NOT NULL DEFAULT 0 CHECK(count>=0),
 PRIMARY KEY(bucket,window_at)
);
CREATE INDEX integration_rate_windows_window_at_idx ON integration_rate_windows(window_at);
ALTER TABLE integration_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_credential_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_rate_windows ENABLE ROW LEVEL SECURITY;
INSERT INTO permissions(code,name,description) VALUES
 ('integrations.view','Ver integraciones API','Ver claves e historial sin revelar secretos'),
 ('integrations.manage','Administrar claves API','Crear y revocar claves limitadas; no concede permisos sobre datos de negocio')
ON CONFLICT(code) DO NOTHING;
