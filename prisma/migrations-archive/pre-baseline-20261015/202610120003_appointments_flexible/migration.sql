-- Activities share the occupied timeline, never commercial bookings or seats.
ALTER TABLE "appointment_sessions"
  ALTER COLUMN "product_id" DROP NOT NULL,
  ADD COLUMN "record_type" VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED_SERVICE',
  ADD COLUMN "purpose" VARCHAR(20),
  ADD COLUMN "title" VARCHAR(200),
  ADD COLUMN "organizer_id" UUID,
  ADD COLUMN "venue" JSONB NOT NULL DEFAULT '{"kind":"BRANCH","name":"","address":"","references":"","url":""}',
  ADD COLUMN "estimated_attendance" INTEGER,
  ADD COLUMN "outbound_minutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "setup_minutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "teardown_minutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "return_minutes" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "appointment_sessions" ADD CONSTRAINT "appointment_record_shape" CHECK (
  ("record_type"='SCHEDULED_SERVICE' AND "product_id" IS NOT NULL)
  OR ("record_type"='ACTIVITY' AND "organizer_id" IS NOT NULL
    AND "title" IS NOT NULL AND length(trim("title")) BETWEEN 1 AND 200
    AND "purpose" IS NOT NULL AND "purpose" IN ('MEETING','SERVICE_VISIT','EVENT')
    AND "mode"='INDIVIDUAL' AND "capacity"=1
    AND "ends_at"-"starts_at" <= interval '31 days'
    AND "occupied_from"="starts_at"-("outbound_minutes"+"setup_minutes")*interval '1 minute'
    AND "occupied_until"="ends_at"+("teardown_minutes"+"return_minutes")*interval '1 minute')
);
ALTER TABLE "appointment_sessions" ADD CONSTRAINT "appointment_margins_check" CHECK (
  "outbound_minutes" BETWEEN 0 AND 1440 AND "setup_minutes" BETWEEN 0 AND 1440
  AND "teardown_minutes" BETWEEN 0 AND 1440 AND "return_minutes" BETWEEN 0 AND 1440
  AND ("estimated_attendance" IS NULL OR "estimated_attendance" BETWEEN 1 AND 1000000)
);
ALTER TABLE "appointment_sessions" ADD CONSTRAINT "appointment_sessions_organizer_id_fkey"
  FOREIGN KEY ("organizer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "appointment_session_type_key" ON "appointment_sessions"("company_id","id","record_type");
CREATE UNIQUE INDEX "appointment_session_branch_type_key" ON "appointment_sessions"("company_id","branch_id","id","record_type");
CREATE INDEX "appointment_organizer_occupied_idx" ON "appointment_sessions"("company_id","organizer_id","occupied_from","occupied_until");

ALTER TABLE "appointment_bookings" ADD COLUMN "session_type" VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED_SERVICE';
ALTER TABLE "appointment_bookings" ADD CONSTRAINT "appointment_booking_type_check" CHECK ("session_type"='SCHEDULED_SERVICE');
ALTER TABLE "appointment_bookings" ADD CONSTRAINT "appointment_booking_session_type_fkey"
  FOREIGN KEY ("company_id","branch_id","session_id","session_type") REFERENCES "appointment_sessions"("company_id","branch_id","id","record_type") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_waitlist" ADD COLUMN "session_type" VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED_SERVICE';
ALTER TABLE "appointment_waitlist" ADD CONSTRAINT "appointment_waitlist_type_check" CHECK ("session_type"='SCHEDULED_SERVICE');
ALTER TABLE "appointment_waitlist" ADD CONSTRAINT "appointment_waitlist_session_type_fkey"
  FOREIGN KEY ("company_id","session_id","session_type") REFERENCES "appointment_sessions"("company_id","id","record_type") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "appointment_participants" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "session_type" VARCHAR(20) NOT NULL DEFAULT 'ACTIVITY',
  "kind" VARCHAR(20) NOT NULL,
  "user_id" UUID,
  "contact_id" UUID,
  "name" VARCHAR(150),
  CONSTRAINT "appointment_participants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "appointment_participant_shape" CHECK (
    "session_type"='ACTIVITY' AND (
      ("kind"='USER' AND "user_id" IS NOT NULL AND "contact_id" IS NULL AND "name" IS NULL)
      OR ("kind"='GUEST' AND "user_id" IS NULL AND "name" IS NOT NULL AND length(trim("name")) BETWEEN 1 AND 150)
    )
  ),
  CONSTRAINT "appointment_participants_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "appointment_participants_company_id_session_id_session_type_fkey" FOREIGN KEY ("company_id","session_id","session_type") REFERENCES "appointment_sessions"("company_id","id","record_type") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "appointment_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "appointment_participants_company_id_contact_id_fkey" FOREIGN KEY ("company_id","contact_id") REFERENCES "suppliers"("company_id","id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "appointment_participants_session_id_user_id_key" ON "appointment_participants"("session_id","user_id");
CREATE UNIQUE INDEX "appointment_participants_session_id_contact_id_key" ON "appointment_participants"("session_id","contact_id");
CREATE INDEX "appointment_participants_company_id_user_id_session_id_idx" ON "appointment_participants"("company_id","user_id","session_id");
ALTER TABLE "appointment_requests" DROP CONSTRAINT "appointment_request_result_check";
ALTER TABLE "service_schedule_profiles" ADD COLUMN "allowed_venue_kinds" TEXT[] NOT NULL DEFAULT ARRAY['BRANCH']::TEXT[];
ALTER TABLE "service_schedule_profiles" ADD CONSTRAINT "service_profile_venue_check" CHECK (
  cardinality("allowed_venue_kinds") BETWEEN 1 AND 4 AND "allowed_venue_kinds" <@ ARRAY['BRANCH','HOME','EVENT_VENUE','ONLINE']::TEXT[]
);
ALTER TABLE "schedule_resources" ADD COLUMN "portable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "schedule_resources" ADD CONSTRAINT "schedule_resource_portable_check" CHECK ("type" <> 'ROOM' OR NOT "portable");
ALTER TABLE "appointment_requests" ADD CONSTRAINT "appointment_request_result_check" CHECK (
  "result_type" IN ('BOOKING','SESSION','WAITLIST','ACTIVITY') AND "input_hash" ~ '^[0-9a-f]{64}$'
);
