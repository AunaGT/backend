-- AlterTable: add estado (0 = inactivo, 1 = activo) to suppliers, then remove status_id.
-- The statuses table is left unchanged.

-- Add estado (0 = inactivo, 1 = activo). Default 1 so existing rows stay active.
ALTER TABLE "suppliers" ADD COLUMN "estado" INTEGER NOT NULL DEFAULT 1;

-- Migrate: status_id 1 = activo (estado 1), other = inactivo (estado 0)
UPDATE "suppliers" SET "estado" = 0 WHERE "status_id" != 1;

ALTER TABLE "suppliers" DROP CONSTRAINT "suppliers_status_id_fkey";
ALTER TABLE "suppliers" DROP COLUMN "status_id";
