-- CreateEnum
CREATE TYPE "public"."EmployeeStatus" AS ENUM ('ACTIVO', 'SUSPENDIDO', 'BAJA');

-- CreateEnum
CREATE TYPE "public"."ContractType" AS ENUM ('INDEFINIDO', 'PLAZO_FIJO', 'POR_OBRA');

-- CreateEnum
CREATE TYPE "public"."PayFrequency" AS ENUM ('MENSUAL', 'QUINCENAL');

-- CreateEnum
CREATE TYPE "public"."AttendanceStatus" AS ENUM ('PRESENTE', 'TARDE', 'AUSENTE', 'VACACIONES', 'INCAPACIDAD', 'PERMISO', 'ASUETO');

-- CreateEnum
CREATE TYPE "public"."AdvanceStatus" AS ENUM ('PENDIENTE', 'PAGADO', 'CANCELADO');

-- CreateTable
CREATE TABLE "public"."employees" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "dpi" VARCHAR(20),
    "nit" VARCHAR(20),
    "igss_number" VARCHAR(20),
    "birth_date" DATE,
    "phone" VARCHAR(50),
    "email" VARCHAR(150),
    "address" TEXT,
    "photo_url" VARCHAR(500),
    "position" VARCHAR(100),
    "department" VARCHAR(100),
    "hire_date" DATE NOT NULL,
    "termination_date" DATE,
    "contract_type" "public"."ContractType" NOT NULL DEFAULT 'INDEFINIDO',
    "pay_frequency" "public"."PayFrequency" NOT NULL DEFAULT 'MENSUAL',
    "base_salary" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "bonificacion_incentivo" DECIMAL(12,2) NOT NULL DEFAULT 250,
    "bank_account" VARCHAR(50),
    "status" "public"."EmployeeStatus" NOT NULL DEFAULT 'ACTIVO',
    "user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."attendance" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "check_in" VARCHAR(5),
    "check_out" VARCHAR(5),
    "hours" DECIMAL(5,2),
    "overtime_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "status" "public"."AttendanceStatus" NOT NULL DEFAULT 'PRESENTE',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."employee_advances" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "installment" DECIMAL(12,2) NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL,
    "reason" TEXT,
    "status" "public"."AdvanceStatus" NOT NULL DEFAULT 'PENDIENTE',
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_advances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employees_user_id_key" ON "public"."employees"("user_id");

-- CreateIndex
CREATE INDEX "employees_branch_id_idx" ON "public"."employees"("branch_id");

-- CreateIndex
CREATE INDEX "employees_status_idx" ON "public"."employees"("status");

-- CreateIndex
CREATE UNIQUE INDEX "employees_company_id_code_key" ON "public"."employees"("company_id", "code");

-- CreateIndex
CREATE INDEX "attendance_company_id_work_date_idx" ON "public"."attendance"("company_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_employee_id_work_date_key" ON "public"."attendance"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "employee_advances_employee_id_status_idx" ON "public"."employee_advances"("employee_id", "status");

-- CreateIndex
CREATE INDEX "employee_advances_company_id_status_idx" ON "public"."employee_advances"("company_id", "status");

-- AddForeignKey
ALTER TABLE "public"."employees" ADD CONSTRAINT "employees_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."employees" ADD CONSTRAINT "employees_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."employees" ADD CONSTRAINT "employees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."attendance" ADD CONSTRAINT "attendance_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."attendance" ADD CONSTRAINT "attendance_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."attendance" ADD CONSTRAINT "attendance_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."employee_advances" ADD CONSTRAINT "employee_advances_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."employee_advances" ADD CONSTRAINT "employee_advances_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."employee_advances" ADD CONSTRAINT "employee_advances_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."employee_advances" ADD CONSTRAINT "employee_advances_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
