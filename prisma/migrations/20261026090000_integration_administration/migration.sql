ALTER TABLE integration_credentials ADD COLUMN paused_at TIMESTAMP(3);
ALTER TABLE integration_audit_events DROP CONSTRAINT integration_audit_events_action_check,
 ADD CONSTRAINT integration_audit_events_action_check CHECK(action IN ('CREATE','REPLACE','REVOKE','USE','CREATE_DRAFT','PAUSE','RESUME'));
CREATE INDEX integration_audit_events_company_id_created_at_id_idx ON integration_audit_events(company_id,created_at,id);
