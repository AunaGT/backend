-- Ventas vinculadas al turno de caja (sesión) para cierres por cajero
ALTER TABLE "sales" ADD COLUMN "cash_register_session_id" UUID;

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_cash_register_session_id_fkey"
  FOREIGN KEY ("cash_register_session_id") REFERENCES "cash_register_sessions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "sales_cash_register_session_id_idx" ON "sales" ("cash_register_session_id");
