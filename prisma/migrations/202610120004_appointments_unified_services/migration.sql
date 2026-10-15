-- Preserve existing scheduling modes and records; remove only the artificial assignment requirement.
ALTER TABLE "service_schedule_profiles" ADD COLUMN "scheduling_style" VARCHAR(20);
ALTER TABLE "service_schedule_profiles" ADD COLUMN "duration_policy" VARCHAR(20) NOT NULL DEFAULT 'FIXED';
UPDATE "service_schedule_profiles" SET "scheduling_style" = CASE WHEN "mode" = 'GROUP' THEN 'CLASS' ELSE 'APPOINTMENT' END;
ALTER TABLE "service_schedule_profiles" ALTER COLUMN "scheduling_style" SET NOT NULL;
ALTER TABLE "service_schedule_profiles" ALTER COLUMN "scheduling_style" SET DEFAULT 'APPOINTMENT';
ALTER TABLE "service_schedule_profiles" DROP CONSTRAINT "service_schedule_profile_rules_check";
ALTER TABLE "service_schedule_profiles" ADD CONSTRAINT "service_schedule_profile_rules_check" CHECK (
  "mode" IN ('INDIVIDUAL','GROUP') AND "scheduling_style" IN ('APPOINTMENT','CLASS','WORK')
  AND "duration_policy" IN ('FIXED','EDITABLE')
  AND (("scheduling_style" = 'CLASS' AND "mode" = 'GROUP') OR ("scheduling_style" IN ('APPOINTMENT','WORK') AND "mode" = 'INDIVIDUAL'))
  AND "duration_minutes" BETWEEN 1 AND CASE WHEN "scheduling_style" = 'WORK' THEN 44640 ELSE 1440 END
  AND "before_minutes" BETWEEN 0 AND 1440 AND "after_minutes" BETWEEN 0 AND 1440
  AND "interval_minutes" BETWEEN 1 AND 1440 AND "lead_minutes" BETWEEN 0 AND 525600
  AND "horizon_days" BETWEEN 1 AND 365 AND "cancellation_hours" BETWEEN 0 AND 8760
  AND "confirmation" IN ('AUTOMATIC','MANUAL') AND "capacity" BETWEEN 1 AND 10000
  AND ("mode" <> 'INDIVIDUAL' OR "capacity" = 1) AND "version" > 0
);
