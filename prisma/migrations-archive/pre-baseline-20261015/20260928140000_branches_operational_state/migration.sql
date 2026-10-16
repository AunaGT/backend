ALTER TABLE "branches" ADD COLUMN "operational_status" VARCHAR(20) NOT NULL DEFAULT 'OPERATING';
ALTER TABLE "branches" ADD COLUMN "manager_user_id" UUID;
CREATE INDEX "branches_manager_user_id_idx" ON "branches"("manager_user_id");
ALTER TABLE "branches" ADD CONSTRAINT "branches_manager_user_id_fkey" FOREIGN KEY ("manager_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
