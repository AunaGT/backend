-- CreateEnum
CREATE TYPE "public"."MerchandiseSource" AS ENUM ('PURCHASE', 'INITIAL');

-- AlterTable
ALTER TABLE "public"."incoming_merchandise" ADD COLUMN     "source" "public"."MerchandiseSource" NOT NULL DEFAULT 'PURCHASE';

-- AlterTable
ALTER TABLE "public"."purchase_logs" ADD COLUMN     "source" "public"."MerchandiseSource" NOT NULL DEFAULT 'PURCHASE';
