-- Lotes que viajan en un traslado: se consumen en el origen al enviar y se
-- recrean en el destino al recibir (o vuelven al origen si se cancela).
ALTER TABLE "stock_transfer_lines" ADD COLUMN "lots_snapshot" JSONB;
