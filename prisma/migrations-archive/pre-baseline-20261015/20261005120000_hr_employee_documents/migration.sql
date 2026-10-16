-- Additive: preserve employee records, legacy photos and payroll data.
ALTER TABLE "employees"
 ADD COLUMN "photo_storage_path" VARCHAR(500),
 ADD COLUMN "gender" VARCHAR(50),
 ADD COLUMN "marital_status" VARCHAR(50),
 ADD COLUMN "nationality" VARCHAR(100),
 ADD COLUMN "workday" VARCHAR(100),
 ADD COLUMN "work_schedule" VARCHAR(200),
 ADD COLUMN "supervisor_id" UUID,
 ADD COLUMN "creation_request_id" UUID,
 ADD COLUMN "creation_request_hash" VARCHAR(64);
ALTER TABLE "employees" ADD CONSTRAINT "employees_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "employees_company_id_creation_request_id_key" ON "employees"("company_id", "creation_request_id");

CREATE TABLE "employee_document_types" (
 "id" UUID NOT NULL,
 "company_id" UUID NOT NULL,
 "name" VARCHAR(100) NOT NULL,
 "instructions" VARCHAR(500) NOT NULL DEFAULT '',
 "required" BOOLEAN NOT NULL DEFAULT false,
 "active" BOOLEAN NOT NULL DEFAULT true,
 "sort_order" INTEGER NOT NULL DEFAULT 0,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "employee_document_types_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "employee_document_types_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "employee_document_types_sort_order_check" CHECK ("sort_order" >= 0)
);
CREATE INDEX "employee_document_types_company_id_active_sort_order_idx" ON "employee_document_types"("company_id", "active", "sort_order");

CREATE TABLE "employee_documents" (
 "id" UUID NOT NULL,
 "company_id" UUID NOT NULL,
 "employee_id" UUID NOT NULL,
 "type_id" UUID NOT NULL,
 "storage_path" VARCHAR(500) NOT NULL,
 "original_name" VARCHAR(255) NOT NULL,
 "mime_type" VARCHAR(100) NOT NULL,
 "size_bytes" INTEGER NOT NULL,
 "sha256" VARCHAR(64) NOT NULL,
 "uploaded_by" UUID NOT NULL,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "archived_at" TIMESTAMP(3),
 CONSTRAINT "employee_documents_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "employee_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "employee_documents_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "employee_documents_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "employee_document_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "employee_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "employee_documents_size_bytes_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 5242880)
);
CREATE INDEX "employee_documents_company_id_employee_id_created_at_idx" ON "employee_documents"("company_id", "employee_id", "created_at");
CREATE UNIQUE INDEX "employee_documents_current_type_key" ON "employee_documents"("employee_id", "type_id") WHERE "archived_at" IS NULL;

CREATE TABLE "employee_history" (
 "id" UUID NOT NULL,
 "company_id" UUID NOT NULL,
 "employee_id" UUID NOT NULL,
 "actor_id" UUID,
 "event" VARCHAR(100) NOT NULL,
 "changes" JSONB NOT NULL,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "employee_history_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "employee_history_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "employee_history_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "employee_history_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "employee_history_company_id_employee_id_created_at_idx" ON "employee_history"("company_id", "employee_id", "created_at");
