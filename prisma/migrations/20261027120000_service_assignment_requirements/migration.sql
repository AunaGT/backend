ALTER TABLE "service_schedule_profiles"
  ADD COLUMN "assignment_requirements" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT "service_assignment_requirements_shape_check" CHECK (
    jsonb_typeof("assignment_requirements") = 'array'
    AND jsonb_array_length("assignment_requirements") <= 20
    AND octet_length("assignment_requirements"::text) <= 65536
  );
