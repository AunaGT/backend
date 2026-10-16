-- Un doble clic o un reintento del navegador tras un timeout creaba dos ventas
-- con dos descuentos de stock. La clave del intento hace que la segunda
-- devuelva la venta que ya existe.
ALTER TABLE "public"."sales" ADD COLUMN "idempotency_key" VARCHAR(64);

-- NULL no choca contra NULL en Postgres, así que las ventas sin clave (todas
-- las históricas, y las de canales que no la mandan) conviven sin problema.
CREATE UNIQUE INDEX "sales_branch_id_idempotency_key_key"
  ON "public"."sales"("branch_id", "idempotency_key");
