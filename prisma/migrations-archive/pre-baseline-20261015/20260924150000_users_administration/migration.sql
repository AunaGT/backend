ALTER TABLE "roles" ADD COLUMN "company_id" UUID, ADD COLUMN "description" VARCHAR(500);
ALTER TABLE "user_companies" ADD COLUMN "status" VARCHAR(12) NOT NULL DEFAULT 'ACTIVE', ADD COLUMN "role_id" INTEGER, ADD COLUMN "last_access_at" TIMESTAMP(3);
ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_status_check" CHECK ("status" IN ('ACTIVE', 'INACTIVE', 'BLOCKED'));
ALTER TABLE "users" ADD COLUMN "auth_version" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "last_login_at" TIMESTAMP(3), ADD COLUMN "password_changed_at" TIMESTAMP(3);
ALTER TABLE "refresh_tokens" ADD COLUMN "session_id" UUID, ADD COLUMN "device" VARCHAR(200);
UPDATE "refresh_tokens" SET "session_id" = "id";
ALTER TABLE "refresh_tokens" ALTER COLUMN "session_id" SET NOT NULL;
CREATE TABLE "user_access_events" (
  "id" UUID NOT NULL, "company_id" UUID NOT NULL, "user_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL, "action" VARCHAR(100) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_access_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "user_access_events_company_id_user_id_created_at_idx" ON "user_access_events"("company_id", "user_id", "created_at");
