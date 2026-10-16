-- CreateTable
CREATE TABLE "service_schedule_profiles" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" VARCHAR(20) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "before_minutes" INTEGER NOT NULL DEFAULT 0,
    "after_minutes" INTEGER NOT NULL DEFAULT 0,
    "interval_minutes" INTEGER NOT NULL DEFAULT 15,
    "lead_minutes" INTEGER NOT NULL DEFAULT 0,
    "horizon_days" INTEGER NOT NULL DEFAULT 60,
    "cancellation_hours" INTEGER NOT NULL DEFAULT 24,
    "confirmation" VARCHAR(20) NOT NULL DEFAULT 'AUTOMATIC',
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "requires_provider" BOOLEAN NOT NULL DEFAULT true,
    "requires_resource" BOOLEAN NOT NULL DEFAULT false,
    "instructions" VARCHAR(2000) NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_schedule_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_providers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "employee_id" UUID,
    "user_id" UUID,
    "name" VARCHAR(150) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_provider_branches" (
    "company_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,

    CONSTRAINT "service_provider_branches_pkey" PRIMARY KEY ("provider_id","branch_id")
);

-- CreateTable
CREATE TABLE "schedule_resources" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "person_capacity" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_schedule_branches" (
    "company_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,

    CONSTRAINT "service_schedule_branches_pkey" PRIMARY KEY ("profile_id","branch_id")
);

-- CreateTable
CREATE TABLE "service_schedule_providers" (
    "company_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,

    CONSTRAINT "service_schedule_providers_pkey" PRIMARY KEY ("profile_id","provider_id")
);

-- CreateTable
CREATE TABLE "service_schedule_resources" (
    "company_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,

    CONSTRAINT "service_schedule_resources_pkey" PRIMARY KEY ("profile_id","resource_id")
);

-- CreateTable
CREATE TABLE "schedule_calendars" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "owner_type" VARCHAR(20) NOT NULL,
    "branch_id" UUID,
    "provider_id" UUID,
    "resource_id" UUID,
    "timezone" VARCHAR(100) NOT NULL,
    "valid_from" DATE,
    "valid_until" DATE,
    "inherit_branch" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_rules" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "calendar_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "from_minute" INTEGER NOT NULL,
    "to_minute" INTEGER NOT NULL,

    CONSTRAINT "availability_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_exceptions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "calendar_id" UUID NOT NULL,
    "local_date" DATE NOT NULL,
    "from_minute" INTEGER,
    "to_minute" INTEGER,
    "reason" VARCHAR(500) NOT NULL DEFAULT '',

    CONSTRAINT "availability_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_sessions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "mode" VARCHAR(20) NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "occupied_from" TIMESTAMP(3) NOT NULL,
    "occupied_until" TIMESTAMP(3) NOT NULL,
    "timezone" VARCHAR(100) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "policy_snapshot" JSONB NOT NULL,
    "notes" VARCHAR(2000) NOT NULL DEFAULT '',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointment_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_session_providers" (
    "company_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,

    CONSTRAINT "appointment_session_providers_pkey" PRIMARY KEY ("session_id","provider_id")
);

-- CreateTable
CREATE TABLE "appointment_session_resources" (
    "company_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,

    CONSTRAINT "appointment_session_resources_pkey" PRIMARY KEY ("session_id","resource_id")
);

-- CreateTable
CREATE TABLE "appointment_bookings" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "quantity" DECIMAL(12,4) NOT NULL,
    "commercial_snapshot" JSONB NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "notes" VARCHAR(2000) NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointment_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_waitlist" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'WAITING',
    "booking_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointment_waitlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_history" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "session_id" UUID,
    "booking_id" UUID,
    "actor_id" UUID NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" VARCHAR(500) NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_requests" (
    "company_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "operation" VARCHAR(50) NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "input_hash" VARCHAR(64) NOT NULL,
    "result_type" VARCHAR(20) NOT NULL,
    "result_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_requests_pkey" PRIMARY KEY ("company_id","actor_id","operation","idempotency_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_schedule_profiles_product_id_key" ON "service_schedule_profiles"("product_id");

-- CreateIndex
CREATE INDEX "service_schedule_profiles_company_id_enabled_idx" ON "service_schedule_profiles"("company_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "service_schedule_profiles_company_id_id_key" ON "service_schedule_profiles"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "service_schedule_profiles_company_id_product_id_key" ON "service_schedule_profiles"("company_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_providers_employee_id_key" ON "service_providers"("employee_id");

-- CreateIndex
CREATE INDEX "service_providers_company_id_active_idx" ON "service_providers"("company_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "service_providers_company_id_id_key" ON "service_providers"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "service_providers_company_id_user_id_key" ON "service_providers"("company_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_providers_company_id_employee_id_key" ON "service_providers"("company_id", "employee_id");

-- CreateIndex
CREATE INDEX "service_provider_branches_company_id_branch_id_idx" ON "service_provider_branches"("company_id", "branch_id");

-- CreateIndex
CREATE INDEX "schedule_resources_company_id_branch_id_active_idx" ON "schedule_resources"("company_id", "branch_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_resources_company_id_id_key" ON "schedule_resources"("company_id", "id");

-- CreateIndex
CREATE INDEX "service_schedule_branches_company_id_branch_id_idx" ON "service_schedule_branches"("company_id", "branch_id");

-- CreateIndex
CREATE INDEX "service_schedule_providers_company_id_provider_id_idx" ON "service_schedule_providers"("company_id", "provider_id");

-- CreateIndex
CREATE INDEX "service_schedule_resources_company_id_resource_id_idx" ON "service_schedule_resources"("company_id", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_calendars_branch_id_key" ON "schedule_calendars"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_calendars_provider_id_key" ON "schedule_calendars"("provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_calendars_resource_id_key" ON "schedule_calendars"("resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_calendars_company_id_id_key" ON "schedule_calendars"("company_id", "id");

-- CreateIndex
CREATE INDEX "availability_rules_company_id_calendar_id_weekday_idx" ON "availability_rules"("company_id", "calendar_id", "weekday");

-- CreateIndex
CREATE INDEX "availability_exceptions_company_id_calendar_id_local_date_idx" ON "availability_exceptions"("company_id", "calendar_id", "local_date");

-- CreateIndex
CREATE INDEX "appointment_sessions_company_id_branch_id_starts_at_idx" ON "appointment_sessions"("company_id", "branch_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointment_sessions_company_id_occupied_from_occupied_unti_idx" ON "appointment_sessions"("company_id", "occupied_from", "occupied_until");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_sessions_company_id_id_key" ON "appointment_sessions"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_sessions_company_id_branch_id_id_key" ON "appointment_sessions"("company_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "appointment_session_providers_company_id_provider_id_sessio_idx" ON "appointment_session_providers"("company_id", "provider_id", "session_id");

-- CreateIndex
CREATE INDEX "appointment_session_resources_company_id_resource_id_sessio_idx" ON "appointment_session_resources"("company_id", "resource_id", "session_id");

-- CreateIndex
CREATE INDEX "appointment_bookings_company_id_branch_id_status_expires_at_idx" ON "appointment_bookings"("company_id", "branch_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "appointment_bookings_company_id_session_id_status_idx" ON "appointment_bookings"("company_id", "session_id", "status");

-- CreateIndex
CREATE INDEX "appointment_bookings_company_id_contact_id_created_at_idx" ON "appointment_bookings"("company_id", "contact_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_bookings_company_id_id_key" ON "appointment_bookings"("company_id", "id");

-- CreateIndex
CREATE INDEX "appointment_waitlist_company_id_session_id_status_created_a_idx" ON "appointment_waitlist"("company_id", "session_id", "status", "created_at", "id");

-- CreateIndex
CREATE INDEX "appointment_history_company_id_session_id_created_at_idx" ON "appointment_history"("company_id", "session_id", "created_at");

-- CreateIndex
CREATE INDEX "appointment_history_company_id_booking_id_created_at_idx" ON "appointment_history"("company_id", "booking_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "branches_company_id_id_key" ON "branches"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_company_id_id_key" ON "suppliers"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "products_company_id_id_key" ON "products"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_company_id_id_key" ON "employees"("company_id", "id");

-- AddForeignKey
ALTER TABLE "service_schedule_profiles" ADD CONSTRAINT "service_schedule_profiles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_schedule_profiles" ADD CONSTRAINT "service_schedule_profiles_company_id_product_id_fkey" FOREIGN KEY ("company_id", "product_id") REFERENCES "products"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_schedule_profiles" ADD CONSTRAINT "service_schedule_profiles_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_providers" ADD CONSTRAINT "service_providers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_providers" ADD CONSTRAINT "service_providers_company_id_employee_id_fkey" FOREIGN KEY ("company_id", "employee_id") REFERENCES "employees"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_providers" ADD CONSTRAINT "service_providers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_providers" ADD CONSTRAINT "service_providers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_provider_branches" ADD CONSTRAINT "service_provider_branches_company_id_provider_id_fkey" FOREIGN KEY ("company_id", "provider_id") REFERENCES "service_providers"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_provider_branches" ADD CONSTRAINT "service_provider_branches_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branches"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_resources" ADD CONSTRAINT "schedule_resources_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_resources" ADD CONSTRAINT "schedule_resources_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branches"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_schedule_branches" ADD CONSTRAINT "service_schedule_branches_company_id_profile_id_fkey" FOREIGN KEY ("company_id", "profile_id") REFERENCES "service_schedule_profiles"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_schedule_branches" ADD CONSTRAINT "service_schedule_branches_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branches"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_schedule_providers" ADD CONSTRAINT "service_schedule_providers_company_id_profile_id_fkey" FOREIGN KEY ("company_id", "profile_id") REFERENCES "service_schedule_profiles"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_schedule_providers" ADD CONSTRAINT "service_schedule_providers_company_id_provider_id_fkey" FOREIGN KEY ("company_id", "provider_id") REFERENCES "service_providers"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_schedule_resources" ADD CONSTRAINT "service_schedule_resources_company_id_profile_id_fkey" FOREIGN KEY ("company_id", "profile_id") REFERENCES "service_schedule_profiles"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_schedule_resources" ADD CONSTRAINT "service_schedule_resources_company_id_resource_id_fkey" FOREIGN KEY ("company_id", "resource_id") REFERENCES "schedule_resources"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_calendars" ADD CONSTRAINT "schedule_calendars_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_calendars" ADD CONSTRAINT "schedule_calendars_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branches"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_calendars" ADD CONSTRAINT "schedule_calendars_company_id_provider_id_fkey" FOREIGN KEY ("company_id", "provider_id") REFERENCES "service_providers"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_calendars" ADD CONSTRAINT "schedule_calendars_company_id_resource_id_fkey" FOREIGN KEY ("company_id", "resource_id") REFERENCES "schedule_resources"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_company_id_calendar_id_fkey" FOREIGN KEY ("company_id", "calendar_id") REFERENCES "schedule_calendars"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_company_id_calendar_id_fkey" FOREIGN KEY ("company_id", "calendar_id") REFERENCES "schedule_calendars"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_sessions" ADD CONSTRAINT "appointment_sessions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_sessions" ADD CONSTRAINT "appointment_sessions_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branches"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_sessions" ADD CONSTRAINT "appointment_sessions_company_id_product_id_fkey" FOREIGN KEY ("company_id", "product_id") REFERENCES "products"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_sessions" ADD CONSTRAINT "appointment_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_session_providers" ADD CONSTRAINT "appointment_session_providers_company_id_session_id_fkey" FOREIGN KEY ("company_id", "session_id") REFERENCES "appointment_sessions"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_session_providers" ADD CONSTRAINT "appointment_session_providers_company_id_provider_id_fkey" FOREIGN KEY ("company_id", "provider_id") REFERENCES "service_providers"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_session_resources" ADD CONSTRAINT "appointment_session_resources_company_id_session_id_fkey" FOREIGN KEY ("company_id", "session_id") REFERENCES "appointment_sessions"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_session_resources" ADD CONSTRAINT "appointment_session_resources_company_id_resource_id_fkey" FOREIGN KEY ("company_id", "resource_id") REFERENCES "schedule_resources"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_bookings" ADD CONSTRAINT "appointment_bookings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_bookings" ADD CONSTRAINT "appointment_bookings_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branches"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_bookings" ADD CONSTRAINT "appointment_bookings_company_id_branch_id_session_id_fkey" FOREIGN KEY ("company_id", "branch_id", "session_id") REFERENCES "appointment_sessions"("company_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_bookings" ADD CONSTRAINT "appointment_bookings_company_id_contact_id_fkey" FOREIGN KEY ("company_id", "contact_id") REFERENCES "suppliers"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_bookings" ADD CONSTRAINT "appointment_bookings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_waitlist" ADD CONSTRAINT "appointment_waitlist_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_waitlist" ADD CONSTRAINT "appointment_waitlist_company_id_session_id_fkey" FOREIGN KEY ("company_id", "session_id") REFERENCES "appointment_sessions"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_waitlist" ADD CONSTRAINT "appointment_waitlist_company_id_contact_id_fkey" FOREIGN KEY ("company_id", "contact_id") REFERENCES "suppliers"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_waitlist" ADD CONSTRAINT "appointment_waitlist_company_id_booking_id_fkey" FOREIGN KEY ("company_id", "booking_id") REFERENCES "appointment_bookings"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_waitlist" ADD CONSTRAINT "appointment_waitlist_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_history" ADD CONSTRAINT "appointment_history_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_history" ADD CONSTRAINT "appointment_history_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branches"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_history" ADD CONSTRAINT "appointment_history_company_id_session_id_fkey" FOREIGN KEY ("company_id", "session_id") REFERENCES "appointment_sessions"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_history" ADD CONSTRAINT "appointment_history_company_id_booking_id_fkey" FOREIGN KEY ("company_id", "booking_id") REFERENCES "appointment_bookings"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_history" ADD CONSTRAINT "appointment_history_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_requests" ADD CONSTRAINT "appointment_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_requests" ADD CONSTRAINT "appointment_requests_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain constraints also protect imports and direct database writes.
ALTER TABLE "service_schedule_profiles" ADD CONSTRAINT "service_schedule_profile_rules_check" CHECK (
  "mode" IN ('INDIVIDUAL','GROUP') AND "duration_minutes" BETWEEN 1 AND 1440
  AND "before_minutes" BETWEEN 0 AND 1440 AND "after_minutes" BETWEEN 0 AND 1440
  AND "interval_minutes" BETWEEN 1 AND 1440 AND "lead_minutes" BETWEEN 0 AND 525600
  AND "horizon_days" BETWEEN 1 AND 365 AND "cancellation_hours" BETWEEN 0 AND 8760
  AND "confirmation" IN ('AUTOMATIC','MANUAL') AND "capacity" BETWEEN 1 AND 10000
  AND ("mode" <> 'INDIVIDUAL' OR "capacity" = 1)
  AND (NOT "enabled" OR "requires_provider" OR "requires_resource") AND "version" > 0
);
ALTER TABLE "service_providers" ADD CONSTRAINT "service_provider_version_check" CHECK ("version" > 0);
ALTER TABLE "schedule_resources" ADD CONSTRAINT "schedule_resource_capacity_check" CHECK (
  "type" IN ('ROOM','EQUIPMENT') AND "version" > 0
  AND ("person_capacity" IS NULL OR "person_capacity" BETWEEN 1 AND 10000)
  AND ("type" <> 'ROOM' OR "person_capacity" IS NOT NULL)
);
ALTER TABLE "schedule_calendars" ADD CONSTRAINT "schedule_calendar_owner_check" CHECK (
  "version" > 0 AND num_nonnulls("branch_id","provider_id","resource_id") = 1
  AND (("owner_type" = 'branch' AND "branch_id" IS NOT NULL AND NOT "inherit_branch")
    OR ("owner_type" = 'provider' AND "provider_id" IS NOT NULL)
    OR ("owner_type" = 'resource' AND "resource_id" IS NOT NULL))
  AND ("valid_from" IS NULL OR "valid_until" IS NULL OR "valid_from" <= "valid_until")
);
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rule_interval_check" CHECK (
  "weekday" BETWEEN 1 AND 7 AND "from_minute" BETWEEN 0 AND 1439
  AND "to_minute" BETWEEN 1 AND 1440 AND "from_minute" < "to_minute"
);
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exception_interval_check" CHECK (
  ("from_minute" IS NULL AND "to_minute" IS NULL) OR
  ("from_minute" IS NOT NULL AND "to_minute" IS NOT NULL AND "from_minute" BETWEEN 0 AND 1439
    AND "to_minute" BETWEEN 1 AND 1440 AND "from_minute" < "to_minute")
);
ALTER TABLE "appointment_sessions" ADD CONSTRAINT "appointment_session_rules_check" CHECK (
  "mode" IN ('INDIVIDUAL','GROUP') AND "capacity" BETWEEN 1 AND 10000
  AND ("mode" <> 'INDIVIDUAL' OR "capacity" = 1) AND "version" > 0
  AND "status" IN ('SCHEDULED','IN_PROGRESS','COMPLETED','CANCELLED')
  AND "occupied_from" <= "starts_at" AND "starts_at" < "ends_at" AND "ends_at" <= "occupied_until"
);
ALTER TABLE "appointment_bookings" ADD CONSTRAINT "appointment_booking_rules_check" CHECK (
  "quantity" > 0 AND "version" > 0
  AND "status" IN ('HELD','PENDING','CONFIRMED','ARRIVED','IN_SERVICE','COMPLETED','NO_SHOW','CANCELLED','EXPIRED')
  AND ("status" NOT IN ('HELD','PENDING') OR "expires_at" IS NOT NULL)
);
CREATE UNIQUE INDEX "appointment_booking_active_contact_key" ON "appointment_bookings"("company_id","session_id","contact_id")
  WHERE "status" IN ('HELD','PENDING','CONFIRMED','ARRIVED','IN_SERVICE');
ALTER TABLE "appointment_waitlist" ADD CONSTRAINT "appointment_waitlist_state_check" CHECK (
  "status" IN ('WAITING','ADMITTED','WITHDRAWN') AND ("status" <> 'ADMITTED' OR "booking_id" IS NOT NULL)
);
CREATE UNIQUE INDEX "appointment_waitlist_active_contact_key" ON "appointment_waitlist"("company_id","session_id","contact_id") WHERE "status" = 'WAITING';
ALTER TABLE "appointment_requests" ADD CONSTRAINT "appointment_request_result_check" CHECK (
  "result_type" IN ('BOOKING','SESSION','WAITLIST') AND "input_hash" ~ '^[0-9a-f]{64}$'
);
