-- Costo del producto al momento de vender. Sin esto, el asiento contable toma el
-- costo de hoy: editar un costo cambiaba el CMV de todas las ventas que aún no
-- se habían contabilizado.
ALTER TABLE "public"."sale_items" ADD COLUMN "unit_cost" DECIMAL(12,2);

-- Las ventas ya existentes se quedan en NULL a propósito: rellenarlas con el
-- costo actual sería inventar un dato histórico. Quien las lea cae al costo del
-- producto, que es exactamente lo que hacía antes.
