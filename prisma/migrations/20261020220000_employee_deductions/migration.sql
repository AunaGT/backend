-- CreateEnum
CREATE TYPE "public"."EmployeeDeductionStatus" AS ENUM ('PENDIENTE', 'APLICADO', 'CANCELADO');

-- AlterTable
ALTER TABLE "public"."payslip_lines" ADD COLUMN     "deduction_id" UUID,
ADD COLUMN     "deduction_snapshot" JSONB;

-- CreateTable
CREATE TABLE "public"."employee_deductions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "public"."EmployeeDeductionStatus" NOT NULL DEFAULT 'PENDIENTE',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "target_run_id" UUID,
    "applied_run_id" UUID,
    "created_by" UUID,
    "updated_by" UUID,
    "cancelled_by" UUID,
    "cancelled_reason" TEXT,
    "applied_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_deductions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_deductions_company_id_branch_id_status_idx" ON "public"."employee_deductions"("company_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "employee_deductions_employee_id_status_idx" ON "public"."employee_deductions"("employee_id", "status");

-- CreateIndex
CREATE INDEX "employee_deductions_target_run_id_idx" ON "public"."employee_deductions"("target_run_id");

-- CreateIndex
CREATE INDEX "employee_deductions_applied_run_id_idx" ON "public"."employee_deductions"("applied_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_company_id_id_key" ON "public"."payroll_runs"("company_id", "id");

-- CreateIndex
CREATE INDEX "payslip_lines_deduction_id_idx" ON "public"."payslip_lines"("deduction_id");

-- AddForeignKey
ALTER TABLE "public"."payslip_lines" ADD CONSTRAINT "payslip_lines_deduction_id_fkey" FOREIGN KEY ("deduction_id") REFERENCES "public"."employee_deductions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."employee_deductions" ADD CONSTRAINT "employee_deductions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."employee_deductions" ADD CONSTRAINT "employee_deductions_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "public"."branches"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."employee_deductions" ADD CONSTRAINT "employee_deductions_company_id_employee_id_fkey" FOREIGN KEY ("company_id", "employee_id") REFERENCES "public"."employees"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."employee_deductions" ADD CONSTRAINT "employee_deductions_company_id_target_run_id_fkey" FOREIGN KEY ("company_id", "target_run_id") REFERENCES "public"."payroll_runs"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."employee_deductions" ADD CONSTRAINT "employee_deductions_company_id_applied_run_id_fkey" FOREIGN KEY ("company_id", "applied_run_id") REFERENCES "public"."payroll_runs"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."employee_deductions" ADD CONSTRAINT "employee_deductions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."employee_deductions" ADD CONSTRAINT "employee_deductions_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."employee_deductions" ADD CONSTRAINT "employee_deductions_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE employee_deductions ADD CONSTRAINT employee_deductions_valid CHECK (amount > 0 AND revision > 0 AND length(btrim(reason)) BETWEEN 1 AND 1000 AND ((status = 'APLICADO') = (applied_run_id IS NOT NULL)) AND ((status = 'APLICADO') = (applied_at IS NOT NULL)) AND ((status = 'CANCELADO') = (cancelled_at IS NOT NULL)));
INSERT INTO permissions(code,name,description) VALUES ('hr.deductions.view','Ver descuentos de salario','Puede consultar descuentos manuales y su historial'),('hr.deductions.manage','Gestionar descuentos de salario','Puede registrar, editar y cancelar descuentos pendientes') ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.system_key='ADMIN' AND r.company_id IS NULL AND r.name='admin' AND p.code IN ('hr.deductions.view','hr.deductions.manage') ON CONFLICT DO NOTHING;

