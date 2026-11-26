-- Confirm this enum-only migration before applying the following DDL.
ALTER TYPE "JournalSourceType" ADD VALUE IF NOT EXISTS 'CASH_DISPUTE_EFFECT';
ALTER TYPE "JournalSourceType" ADD VALUE IF NOT EXISTS 'CASH_DISPUTE_DISPOSITION';
ALTER TYPE "JournalSourceType" ADD VALUE IF NOT EXISTS 'CASH_DISPUTE_ADJUSTMENT';
