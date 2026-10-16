-- Disponibilidad para venta (POS / API de ventas)
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "available_for_sale" BOOLEAN NOT NULL DEFAULT true;
