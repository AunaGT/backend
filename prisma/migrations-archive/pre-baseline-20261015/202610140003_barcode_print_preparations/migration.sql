CREATE TABLE "barcode_print_preparations" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "request_key" UUID NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "barcode_print_preparations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "barcode_print_preparations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "barcode_print_preparations_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "barcode_print_preparations_company_id_branch_id_fkey" FOREIGN KEY ("company_id","branch_id") REFERENCES "branches"("company_id","id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "barcode_print_preparations_company_id_actor_id_request_key_key" ON "barcode_print_preparations"("company_id","actor_id","request_key");
CREATE INDEX "barcode_print_preparations_company_id_created_at_idx" ON "barcode_print_preparations"("company_id","created_at");
-- Snapshots are served only by the authenticated backend, not Supabase anonymous REST.
ALTER TABLE "barcode_print_preparations" ENABLE ROW LEVEL SECURITY;
