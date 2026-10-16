-- Origen de asiento para ajustes de inventario (manuales, conteos, bajas de
-- lote). Sin él la cuenta de Inventario solo se movía con compras y ventas.
ALTER TYPE "public"."JournalSourceType" ADD VALUE IF NOT EXISTS 'STOCK_ADJUSTMENT';
