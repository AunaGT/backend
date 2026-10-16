-- Caja registradora por defecto + sesiones de apertura (una OPEN por caja)
CREATE TYPE "CashRegisterSessionStatus" AS ENUM ('OPEN', 'CLOSED', 'VOID');

CREATE TABLE "cash_registers" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_registers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cash_registers_code_key" ON "cash_registers"("code");

CREATE TABLE "cash_register_sessions" (
    "id" UUID NOT NULL,
    "cash_register_id" UUID NOT NULL,
    "status" "CashRegisterSessionStatus" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "opened_by_id" UUID NOT NULL,
    "closed_by_id" UUID,
    "opening_float" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,
    "cash_closure_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_register_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cash_register_sessions_cash_closure_id_key" ON "cash_register_sessions"("cash_closure_id");

CREATE INDEX "cash_register_sessions_cash_register_id_status_idx" ON "cash_register_sessions"("cash_register_id", "status");

CREATE INDEX "cash_register_sessions_opened_by_id_idx" ON "cash_register_sessions"("opened_by_id");

ALTER TABLE "cash_register_sessions" ADD CONSTRAINT "cash_register_sessions_cash_register_id_fkey" FOREIGN KEY ("cash_register_id") REFERENCES "cash_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cash_register_sessions" ADD CONSTRAINT "cash_register_sessions_opened_by_id_fkey" FOREIGN KEY ("opened_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cash_register_sessions" ADD CONSTRAINT "cash_register_sessions_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cash_register_sessions" ADD CONSTRAINT "cash_register_sessions_cash_closure_id_fkey" FOREIGN KEY ("cash_closure_id") REFERENCES "cash_closures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Una sola sesión OPEN por caja (PostgreSQL partial unique index)
CREATE UNIQUE INDEX "cash_register_sessions_one_open_per_register" ON "cash_register_sessions" ("cash_register_id") WHERE ("status" = 'OPEN');

-- Caja principal por defecto (id fijo para upsert en seed)
INSERT INTO "cash_registers" ("id", "name", "code", "is_default", "active", "created_at", "updated_at")
VALUES (
    'c0ffee00-0000-4000-8000-000000000001',
    'Caja principal',
    'PRINCIPAL',
    true,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
) ON CONFLICT ("id") DO NOTHING;
