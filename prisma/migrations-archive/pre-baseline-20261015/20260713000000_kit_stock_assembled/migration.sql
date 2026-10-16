-- Kits: opción de armar por adelantado (stock propio) en vez de descontar solo al vender
ALTER TABLE "products" ADD COLUMN "stock_assembled" BOOLEAN NOT NULL DEFAULT false;
