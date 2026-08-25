/*
  Warnings:

  - You are about to drop the column `address` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `hire_date` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `is_employee` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `phone` on the `users` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."users" DROP COLUMN "address",
DROP COLUMN "hire_date",
DROP COLUMN "is_employee",
DROP COLUMN "phone";
