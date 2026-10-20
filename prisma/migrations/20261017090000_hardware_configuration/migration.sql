-- CreateTable
CREATE TABLE "public"."hardware_workstations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "cash_register_id" UUID,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "notes" VARCHAR(500) NOT NULL DEFAULT '',
    "state" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hardware_workstations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."hardware_devices" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "notes" VARCHAR(500) NOT NULL DEFAULT '',
    "kind" VARCHAR(30) NOT NULL,
    "connection" VARCHAR(30) NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "profile" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hardware_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."hardware_assignments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "workstation_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "role" VARCHAR(20) NOT NULL,

    CONSTRAINT "hardware_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."hardware_test_runs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "request_key" UUID NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "workstation_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "mode" VARCHAR(20) NOT NULL,
    "outcome" VARCHAR(30) NOT NULL,
    "sample_code" VARCHAR(128),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hardware_test_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."hardware_audit_events" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "entity_id" UUID NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hardware_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hardware_workstations_company_id_branch_id_idx" ON "public"."hardware_workstations"("company_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "hardware_workstations_branch_id_code_key" ON "public"."hardware_workstations"("branch_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "hardware_workstations_company_id_branch_id_id_key" ON "public"."hardware_workstations"("company_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "hardware_devices_company_id_branch_id_idx" ON "public"."hardware_devices"("company_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "hardware_devices_branch_id_code_key" ON "public"."hardware_devices"("branch_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "hardware_devices_company_id_branch_id_id_key" ON "public"."hardware_devices"("company_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "hardware_assignments_company_id_branch_id_device_id_idx" ON "public"."hardware_assignments"("company_id", "branch_id", "device_id");

-- CreateIndex
CREATE UNIQUE INDEX "hardware_assignments_workstation_id_role_key" ON "public"."hardware_assignments"("workstation_id", "role");

-- CreateIndex
CREATE INDEX "hardware_test_runs_company_id_branch_id_created_at_idx" ON "public"."hardware_test_runs"("company_id", "branch_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "hardware_test_runs_company_id_actor_id_request_key_key" ON "public"."hardware_test_runs"("company_id", "actor_id", "request_key");

-- CreateIndex
CREATE INDEX "hardware_audit_events_company_id_branch_id_created_at_idx" ON "public"."hardware_audit_events"("company_id", "branch_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "cash_registers_branch_id_id_key" ON "public"."cash_registers"("branch_id", "id");

-- AddForeignKey
ALTER TABLE "public"."hardware_workstations" ADD CONSTRAINT "hardware_workstations_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "public"."branches"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hardware_workstations" ADD CONSTRAINT "hardware_workstations_branch_id_cash_register_id_fkey" FOREIGN KEY ("branch_id", "cash_register_id") REFERENCES "public"."cash_registers"("branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hardware_devices" ADD CONSTRAINT "hardware_devices_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "public"."branches"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hardware_assignments" ADD CONSTRAINT "hardware_assignments_company_id_branch_id_workstation_id_fkey" FOREIGN KEY ("company_id", "branch_id", "workstation_id") REFERENCES "public"."hardware_workstations"("company_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hardware_assignments" ADD CONSTRAINT "hardware_assignments_company_id_branch_id_device_id_fkey" FOREIGN KEY ("company_id", "branch_id", "device_id") REFERENCES "public"."hardware_devices"("company_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hardware_test_runs" ADD CONSTRAINT "hardware_test_runs_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "public"."branches"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hardware_test_runs" ADD CONSTRAINT "hardware_test_runs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hardware_test_runs" ADD CONSTRAINT "hardware_test_runs_company_id_branch_id_workstation_id_fkey" FOREIGN KEY ("company_id", "branch_id", "workstation_id") REFERENCES "public"."hardware_workstations"("company_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hardware_test_runs" ADD CONSTRAINT "hardware_test_runs_company_id_branch_id_device_id_fkey" FOREIGN KEY ("company_id", "branch_id", "device_id") REFERENCES "public"."hardware_devices"("company_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hardware_audit_events" ADD CONSTRAINT "hardware_audit_events_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "public"."branches"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hardware_audit_events" ADD CONSTRAINT "hardware_audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A logical register has one active primary workstation; drafts may be prepared safely.
CREATE UNIQUE INDEX "hardware_one_active_workstation_per_register" ON "public"."hardware_workstations" ("cash_register_id") WHERE "state" = 'ACTIVE' AND "cash_register_id" IS NOT NULL;
ALTER TABLE "public"."hardware_workstations" ADD CONSTRAINT "hardware_workstation_state" CHECK ("state" IN ('DRAFT','ACTIVE','DISABLED') AND "version" > 0);
ALTER TABLE "public"."hardware_devices" ADD CONSTRAINT "hardware_device_state" CHECK ("state" IN ('DRAFT','ACTIVE','DISABLED') AND "version" > 0);
ALTER TABLE "public"."hardware_devices" ADD CONSTRAINT "hardware_device_kind_connection" CHECK (("kind" = 'SCANNER' AND "connection" = 'HID') OR ("kind" IN ('RECEIPT_PRINTER','LABEL_PRINTER','OFFICE_PRINTER') AND "connection" = 'SYSTEM_PRINTER') OR ("kind" = 'CASH_DRAWER' AND "connection" = 'PRINTER_PORT'));
ALTER TABLE "public"."hardware_assignments" ADD CONSTRAINT "hardware_assignment_role" CHECK ("role" IN ('SCANNER','RECEIPT','LABEL','OFFICE','DRAWER'));
ALTER TABLE "public"."hardware_test_runs" ADD CONSTRAINT "hardware_test_outcome" CHECK ("outcome" IN ('SIMULATED','PREPARED','INPUT_RECEIVED','ERROR') AND "mode" IN ('SIMULATED','BROWSER') AND ("kind" <> 'DRAWER_SIMULATION' OR ("mode" = 'SIMULATED' AND "outcome" = 'SIMULATED')));

-- Configuration and audit are accessible only through the authenticated backend.
ALTER TABLE "public"."hardware_workstations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."hardware_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."hardware_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."hardware_test_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."hardware_audit_events" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."hardware_workstations", "public"."hardware_devices", "public"."hardware_assignments", "public"."hardware_test_runs", "public"."hardware_audit_events" FROM PUBLIC, anon, authenticated, service_role;
