-- CreateEnum
CREATE TYPE "public"."PayrollType" AS ENUM ('ORDINARIA', 'AGUINALDO', 'BONO14');

-- CreateEnum
CREATE TYPE "public"."PayrollStatus" AS ENUM ('BORRADOR', 'CONFIRMADA', 'PAGADA', 'ANULADA');

-- CreateEnum
CREATE TYPE "public"."PayslipLineType" AS ENUM ('DEVENGO', 'DEDUCCION', 'COSTO_PATRONAL');

-- CreateEnum
CREATE TYPE "public"."PayrollConcept" AS ENUM ('SUELDO_ORDINARIO', 'BONIFICACION_INCENTIVO', 'HORAS_EXTRA', 'AGUINALDO', 'BONO14', 'OTRO_DEVENGO', 'IGSS_LABORAL', 'ISR_RETENIDO', 'ANTICIPO', 'OTRA_DEDUCCION', 'IGSS_PATRONAL', 'IRTRA', 'INTECAP', 'PROVISION_AGUINALDO', 'PROVISION_BONO14', 'PROVISION_VACACIONES', 'PROVISION_INDEMNIZACION');

-- CreateTable
CREATE TABLE "public"."payroll_runs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "type" "public"."PayrollType" NOT NULL DEFAULT 'ORDINARIA',
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "pay_date" DATE NOT NULL,
    "status" "public"."PayrollStatus" NOT NULL DEFAULT 'BORRADOR',
    "total_earnings" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_deductions" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_net" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_employer_cost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_by" UUID,
    "confirmed_by" UUID,
    "cancelled_by" UUID,
    "confirmed_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."payslips" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "base_salary" DECIMAL(12,2) NOT NULL,
    "days_worked" DECIMAL(5,2) NOT NULL,
    "igss_base" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "isr_base" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_earnings" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_deductions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "net_pay" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "employer_cost" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."payslip_lines" (
    "id" UUID NOT NULL,
    "payslip_id" UUID NOT NULL,
    "concept" "public"."PayrollConcept" NOT NULL,
    "type" "public"."PayslipLineType" NOT NULL,
    "description" VARCHAR(150) NOT NULL,
    "quantity" DECIMAL(10,2),
    "amount" DECIMAL(12,2) NOT NULL,
    "advance_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "payslip_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_runs_branch_id_status_idx" ON "public"."payroll_runs"("branch_id", "status");

-- CreateIndex
CREATE INDEX "payroll_runs_company_id_pay_date_idx" ON "public"."payroll_runs"("company_id", "pay_date");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_company_id_code_key" ON "public"."payroll_runs"("company_id", "code");

-- CreateIndex
CREATE INDEX "payslips_employee_id_idx" ON "public"."payslips"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_run_id_employee_id_key" ON "public"."payslips"("run_id", "employee_id");

-- CreateIndex
CREATE INDEX "payslip_lines_payslip_id_idx" ON "public"."payslip_lines"("payslip_id");

-- CreateIndex
CREATE INDEX "payslip_lines_advance_id_idx" ON "public"."payslip_lines"("advance_id");

-- AddForeignKey
ALTER TABLE "public"."payroll_runs" ADD CONSTRAINT "payroll_runs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payroll_runs" ADD CONSTRAINT "payroll_runs_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payroll_runs" ADD CONSTRAINT "payroll_runs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payroll_runs" ADD CONSTRAINT "payroll_runs_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payroll_runs" ADD CONSTRAINT "payroll_runs_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payslips" ADD CONSTRAINT "payslips_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payslips" ADD CONSTRAINT "payslips_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payslip_lines" ADD CONSTRAINT "payslip_lines_payslip_id_fkey" FOREIGN KEY ("payslip_id") REFERENCES "public"."payslips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payslip_lines" ADD CONSTRAINT "payslip_lines_advance_id_fkey" FOREIGN KEY ("advance_id") REFERENCES "public"."employee_advances"("id") ON DELETE SET NULL ON UPDATE CASCADE;
