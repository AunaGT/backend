-- Fondo inicial de caja al momento del arqueo (turno ligado al cierre)
ALTER TABLE "cash_closures" ADD COLUMN "opening_float" DECIMAL(12,2);
