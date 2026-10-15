ALTER TABLE roles ADD COLUMN system_key VARCHAR(16),
 ADD COLUMN legacy_role_id INTEGER,
 ADD COLUMN revision INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN name_key TEXT GENERATED ALWAYS AS (lower(btrim(name))) STORED;
DROP INDEX roles_name_key;
CREATE UNIQUE INDEX roles_system_key_key ON roles(system_key);
CREATE UNIQUE INDEX roles_company_name_key ON roles(company_id,name_key);
CREATE UNIQUE INDEX roles_company_legacy_key ON roles(company_id,legacy_role_id);
ALTER TABLE roles ADD CONSTRAINT roles_revision_check CHECK(revision>=0),
 ADD CONSTRAINT roles_system_check CHECK(system_key IS NULL OR
  (system_key='ADMIN' AND company_id IS NULL AND name='admin')),
 ADD CONSTRAINT roles_local_reserved_name_check CHECK(company_id IS NULL
  OR name_key NOT IN ('admin','administrador')),
 ADD CONSTRAINT roles_company_id_fkey FOREIGN KEY(company_id)
  REFERENCES companies(id) ON DELETE RESTRICT,
 ADD CONSTRAINT roles_legacy_role_id_fkey FOREIGN KEY(legacy_role_id)
  REFERENCES roles(id) ON DELETE RESTRICT;
