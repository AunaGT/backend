-- Run with psql -v ON_ERROR_STOP=1 against the disposable local test database.
BEGIN;
CREATE SCHEMA order_migration_check;
SET LOCAL search_path TO order_migration_check;
CREATE TABLE commercial_documents (id UUID PRIMARY KEY);
CREATE TABLE commercial_document_lines (id UUID PRIMARY KEY, qty INTEGER NOT NULL, qty_fulfilled INTEGER NOT NULL);
INSERT INTO commercial_documents VALUES ('00000000-0000-4000-8000-000000000001');
INSERT INTO commercial_document_lines VALUES ('00000000-0000-4000-8000-000000000002', 10, 4);
\ir ../prisma/migrations/20260924100000_order_deliveries/migration.sql
DO $$ BEGIN
  IF (SELECT fulfillment_mode FROM commercial_documents LIMIT 1) <> 'LEGACY' THEN
    RAISE EXCEPTION 'La migración modificó el modo de pedidos históricos';
  END IF;
  IF (SELECT qty_invoiced FROM commercial_document_lines LIMIT 1) <> 4 THEN
    RAISE EXCEPTION 'No se conservaron las cantidades facturadas históricas';
  END IF;
END $$;
ROLLBACK;
