ALTER TABLE "appointment_sessions"
ADD COLUMN "operational_timeline" JSONB NOT NULL DEFAULT '{"schemaVersion":1,"milestones":[],"attendanceWindows":[],"requirementWindows":[]}';

ALTER TABLE "appointment_sessions" ADD CONSTRAINT "appointment_sessions_operational_timeline_check" CHECK (
  jsonb_typeof("operational_timeline") = 'object'
  AND ("operational_timeline"->'schemaVersion') = '1'::jsonb
  AND jsonb_typeof("operational_timeline"->'milestones') = 'array'
  AND jsonb_typeof("operational_timeline"->'attendanceWindows') = 'array'
  AND jsonb_typeof("operational_timeline"->'requirementWindows') = 'array'
  AND CASE WHEN jsonb_typeof("operational_timeline"->'milestones') = 'array' THEN jsonb_array_length("operational_timeline"->'milestones') <= 32 ELSE false END
  AND CASE WHEN jsonb_typeof("operational_timeline"->'attendanceWindows') = 'array' THEN jsonb_array_length("operational_timeline"->'attendanceWindows') <= 100 ELSE false END
  AND CASE WHEN jsonb_typeof("operational_timeline"->'requirementWindows') = 'array' THEN jsonb_array_length("operational_timeline"->'requirementWindows') <= 20 ELSE false END
  AND octet_length("operational_timeline"::text) <= 65536
  AND "operational_timeline" ?& ARRAY['schemaVersion','milestones','attendanceWindows','requirementWindows']
);
