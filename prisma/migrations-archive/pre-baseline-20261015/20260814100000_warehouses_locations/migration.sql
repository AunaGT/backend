-- CreateEnum
CREATE TYPE "public"."WarehouseKind" AS ENUM ('BODEGA', 'SALA_VENTAS', 'VITRINA', 'TRANSITO', 'OTRO');

-- CreateEnum
CREATE TYPE "public"."StockMovementReason" AS ENUM ('INITIAL', 'PURCHASE', 'SALE', 'SALE_RETURN', 'ORDER_FULFILL', 'TRANSFER_OUT', 'TRANSFER_IN', 'TRANSFER_CANCEL', 'INTERNAL_MOVE', 'COUNT_ADJUST', 'MANUAL_ADJUST', 'KIT_ASSEMBLE', 'KIT_DISASSEMBLE');

-- CreateTable
CREATE TABLE "public"."warehouses" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "kind" "public"."WarehouseKind" NOT NULL DEFAULT 'BODEGA',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_receiving" BOOLEAN NOT NULL DEFAULT false,
    "dispatch_priority" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."stock_locations" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(120),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "pickable" BOOLEAN NOT NULL DEFAULT true,
    "dispatch_priority" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."product_stock_locations" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "min_stock" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_stock_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."stock_movements" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "balance" INTEGER NOT NULL,
    "reason" "public"."StockMovementReason" NOT NULL,
    "ref_type" VARCHAR(30),
    "ref_id" UUID,
    "group_id" UUID,
    "notes" VARCHAR(300),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "warehouses_branch_id_active_idx" ON "public"."warehouses"("branch_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_branch_id_code_key" ON "public"."warehouses"("branch_id", "code");

-- CreateIndex
CREATE INDEX "stock_locations_warehouse_id_active_idx" ON "public"."stock_locations"("warehouse_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "stock_locations_warehouse_id_code_key" ON "public"."stock_locations"("warehouse_id", "code");

-- CreateIndex
CREATE INDEX "product_stock_locations_location_id_idx" ON "public"."product_stock_locations"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_stock_locations_product_id_location_id_key" ON "public"."product_stock_locations"("product_id", "location_id");

-- CreateIndex
CREATE INDEX "stock_movements_branch_id_created_at_idx" ON "public"."stock_movements"("branch_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "stock_movements_product_id_created_at_idx" ON "public"."stock_movements"("product_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "stock_movements_location_id_created_at_idx" ON "public"."stock_movements"("location_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "stock_movements_ref_type_ref_id_idx" ON "public"."stock_movements"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "stock_movements_group_id_idx" ON "public"."stock_movements"("group_id");

-- AddForeignKey
ALTER TABLE "public"."warehouses" ADD CONSTRAINT "warehouses_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."stock_locations" ADD CONSTRAINT "stock_locations_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."product_stock_locations" ADD CONSTRAINT "product_stock_locations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."product_stock_locations" ADD CONSTRAINT "product_stock_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."stock_movements" ADD CONSTRAINT "stock_movements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."stock_movements" ADD CONSTRAINT "stock_movements_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."stock_movements" ADD CONSTRAINT "stock_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."stock_movements" ADD CONSTRAINT "stock_movements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ============================================================
-- Backfill: cada sucursal nace con un almacén "Principal" y su
-- ubicación "GENERAL", y todo el stock de sucursal cae ahí.
-- Cero cambio de comportamiento: un solo destino posible.
-- ============================================================

INSERT INTO "public"."warehouses" (id, branch_id, name, code, kind, is_default, is_receiving, dispatch_priority, active, created_at, updated_at)
SELECT gen_random_uuid(), b.id, 'Principal', 'PRIN', 'BODEGA', true, true, 10, true, now(), now()
FROM "public"."branches" b;

INSERT INTO "public"."stock_locations" (id, warehouse_id, code, name, is_default, pickable, dispatch_priority, active, created_at)
SELECT gen_random_uuid(), w.id, 'GENERAL', 'General', true, true, 10, true, now()
FROM "public"."warehouses" w;

INSERT INTO "public"."product_stock_locations" (id, product_id, location_id, stock, min_stock)
SELECT gen_random_uuid(), ps.product_id, l.id, ps.stock, 0
FROM "public"."product_stocks" ps
JOIN "public"."warehouses" w ON w.branch_id = ps.branch_id AND w.is_default
JOIN "public"."stock_locations" l ON l.warehouse_id = w.id AND l.is_default;

-- El kardex arranca con la verdad, no en cero.
INSERT INTO "public"."stock_movements" (id, branch_id, location_id, product_id, qty, balance, reason, created_at)
SELECT gen_random_uuid(), w.branch_id, psl.location_id, psl.product_id, psl.stock, psl.stock, 'INITIAL', now()
FROM "public"."product_stock_locations" psl
JOIN "public"."stock_locations" l ON l.id = psl.location_id
JOIN "public"."warehouses" w ON w.id = l.warehouse_id
WHERE psl.stock <> 0;
