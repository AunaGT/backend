-- Keep all existing deadlines unchanged. NULL is an explicit non-expiring key.
ALTER TABLE integration_credentials
 ALTER COLUMN expires_at DROP NOT NULL,
 DROP CONSTRAINT integration_credentials_check,
 ADD CONSTRAINT integration_credentials_expiry_check CHECK (
  expires_at IS NULL OR
  (expires_at > created_at AND expires_at <= created_at + INTERVAL '365 days')
 );
