-- CreateTable
CREATE TABLE "public"."product_categories" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."statuses" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,

    CONSTRAINT "statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."stock_statuses" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,

    CONSTRAINT "stock_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."payment_methods" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sale_statuses" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,

    CONSTRAINT "sale_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."return_statuses" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,

    CONSTRAINT "return_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."payment_terms" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "payment_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."alert_types" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,

    CONSTRAINT "alert_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."alert_priorities" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,

    CONSTRAINT "alert_priorities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."suppliers" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "contact" VARCHAR(100) NOT NULL,
    "phone" VARCHAR(50),
    "email" VARCHAR(150),
    "address" TEXT,
    "category_id" INTEGER NOT NULL,
    "products" INTEGER NOT NULL DEFAULT 0,
    "last_order" TIMESTAMP(3),
    "total_purchases" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "rating" DECIMAL(3,2),
    "status_id" INTEGER NOT NULL,
    "payment_terms_id" INTEGER NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."products" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "category_id" INTEGER NOT NULL,
    "brand" VARCHAR(100),
    "size" VARCHAR(50),
    "stock" INTEGER NOT NULL DEFAULT 0,
    "min_stock" INTEGER NOT NULL DEFAULT 0,
    "price" DECIMAL(12,2) NOT NULL,
    "cost" DECIMAL(12,2) NOT NULL,
    "image_url" VARCHAR(500),
    "supplier_id" UUID NOT NULL,
    "barcode" VARCHAR(100),
    "description" TEXT,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "status_id" INTEGER NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."roles" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."permissions" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."role_permissions" (
    "role_id" INTEGER NOT NULL,
    "permission_id" INTEGER NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "public"."users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "email" VARCHAR(150) NOT NULL,
    "password" VARCHAR(255) NOT NULL,
    "role_id" INTEGER NOT NULL,
    "is_employee" BOOLEAN NOT NULL DEFAULT false,
    "photo_url" VARCHAR(500),
    "phone" VARCHAR(50),
    "address" TEXT,
    "hire_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."alerts" (
    "id" UUID NOT NULL,
    "type_id" INTEGER NOT NULL,
    "priority_id" INTEGER NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "message" TEXT,
    "product_id" UUID NOT NULL,
    "current_stock" INTEGER,
    "min_stock" INTEGER,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status_id" INTEGER NOT NULL,
    "assigned_to" UUID,
    "resolved" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sales" (
    "id" UUID NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customer" VARCHAR(150),
    "customer_nit" VARCHAR(50),
    "is_final_consumer" BOOLEAN NOT NULL DEFAULT true,
    "subtotal" DECIMAL(12,2),
    "discount_total" DECIMAL(12,2),
    "total" DECIMAL(12,2) NOT NULL,
    "total_returned" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "adjusted_total" DECIMAL(12,2) NOT NULL,
    "items" INTEGER NOT NULL,
    "payment_method_id" INTEGER NOT NULL,
    "status_id" INTEGER NOT NULL,
    "amount_received" DECIMAL(12,2),
    "change" DECIMAL(12,2),
    "sold_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sale_items" (
    "id" SERIAL NOT NULL,
    "sale_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "qty" INTEGER NOT NULL,

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."purchase_logs" (
    "id" SERIAL NOT NULL,
    "product_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cost" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "purchase_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."incoming_merchandise" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "registered_by" UUID NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "incoming_merchandise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."incoming_merchandise_items" (
    "id" UUID NOT NULL,
    "incoming_merchandise_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_cost" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "incoming_merchandise_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."returns" (
    "id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "return_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "total_refund" DECIMAL(12,2) NOT NULL,
    "items_count" INTEGER NOT NULL DEFAULT 0,
    "status_id" INTEGER NOT NULL,
    "processed_by" UUID,
    "processed_at" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."return_items" (
    "id" SERIAL NOT NULL,
    "return_id" UUID NOT NULL,
    "sale_item_id" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "qty_returned" INTEGER NOT NULL,
    "refund_amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT,

    CONSTRAINT "return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."cash_closures" (
    "id" UUID NOT NULL,
    "closure_number" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "cashier_name" VARCHAR(100) NOT NULL,
    "cashier_signature" TEXT,
    "supervisor_name" VARCHAR(100),
    "supervisor_signature" TEXT,
    "supervisor_validated_at" TIMESTAMP(3),
    "theoretical_total" DECIMAL(12,2) NOT NULL,
    "theoretical_sales" DECIMAL(12,2) NOT NULL,
    "theoretical_returns" DECIMAL(12,2) NOT NULL,
    "actual_total" DECIMAL(12,2) NOT NULL,
    "difference" DECIMAL(12,2) NOT NULL,
    "difference_percentage" DECIMAL(5,2),
    "total_transactions" INTEGER NOT NULL,
    "total_customers" INTEGER NOT NULL,
    "average_ticket" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,
    "status" VARCHAR(50) NOT NULL DEFAULT 'Pendiente',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cash_closures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."cash_closure_payments" (
    "id" SERIAL NOT NULL,
    "cash_closure_id" UUID NOT NULL,
    "payment_method_id" INTEGER NOT NULL,
    "theoretical_amount" DECIMAL(12,2) NOT NULL,
    "theoretical_count" INTEGER NOT NULL,
    "actual_amount" DECIMAL(12,2) NOT NULL,
    "actual_count" INTEGER,
    "difference" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,

    CONSTRAINT "cash_closure_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."cash_closure_denominations" (
    "id" SERIAL NOT NULL,
    "cash_closure_id" UUID NOT NULL,
    "denomination" DECIMAL(10,2) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "cash_closure_denominations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."promotion_types" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "description" TEXT,

    CONSTRAINT "promotion_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."promotions" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "type_id" INTEGER NOT NULL,
    "discount_value" DECIMAL(12,2),
    "discount_percentage" DECIMAL(5,2),
    "buy_quantity" INTEGER,
    "get_quantity" INTEGER,
    "min_quantity" INTEGER,
    "applies_to_all" BOOLEAN NOT NULL DEFAULT false,
    "trigger_product_id" UUID,
    "target_product_id" UUID,
    "start_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "end_date" TIMESTAMP(3),
    "max_uses" INTEGER,
    "max_uses_per_customer" INTEGER,
    "min_purchase_amount" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."promotion_codes" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "promotion_id" UUID NOT NULL,
    "current_uses" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."promotion_products" (
    "id" SERIAL NOT NULL,
    "promotion_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,

    CONSTRAINT "promotion_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."promotion_categories" (
    "id" SERIAL NOT NULL,
    "promotion_id" UUID NOT NULL,
    "category_id" INTEGER NOT NULL,

    CONSTRAINT "promotion_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sale_promotions" (
    "id" SERIAL NOT NULL,
    "sale_id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "discount_applied" DECIMAL(12,2) NOT NULL,
    "code_used" VARCHAR(50),

    CONSTRAINT "sale_promotions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_name_key" ON "public"."product_categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "statuses_name_key" ON "public"."statuses"("name");

-- CreateIndex
CREATE UNIQUE INDEX "stock_statuses_name_key" ON "public"."stock_statuses"("name");

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_name_key" ON "public"."payment_methods"("name");

-- CreateIndex
CREATE UNIQUE INDEX "sale_statuses_name_key" ON "public"."sale_statuses"("name");

-- CreateIndex
CREATE UNIQUE INDEX "return_statuses_name_key" ON "public"."return_statuses"("name");

-- CreateIndex
CREATE UNIQUE INDEX "payment_terms_name_key" ON "public"."payment_terms"("name");

-- CreateIndex
CREATE UNIQUE INDEX "alert_types_name_key" ON "public"."alert_types"("name");

-- CreateIndex
CREATE UNIQUE INDEX "alert_priorities_name_key" ON "public"."alert_priorities"("name");

-- CreateIndex
CREATE UNIQUE INDEX "products_barcode_key" ON "public"."products"("barcode");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "public"."roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "public"."permissions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "public"."users"("email");

-- CreateIndex
CREATE INDEX "purchase_logs_product_id_idx" ON "public"."purchase_logs"("product_id");

-- CreateIndex
CREATE INDEX "purchase_logs_supplier_id_idx" ON "public"."purchase_logs"("supplier_id");

-- CreateIndex
CREATE INDEX "incoming_merchandise_supplier_id_idx" ON "public"."incoming_merchandise"("supplier_id");

-- CreateIndex
CREATE INDEX "incoming_merchandise_registered_by_idx" ON "public"."incoming_merchandise"("registered_by");

-- CreateIndex
CREATE INDEX "incoming_merchandise_date_idx" ON "public"."incoming_merchandise"("date");

-- CreateIndex
CREATE INDEX "incoming_merchandise_items_incoming_merchandise_id_idx" ON "public"."incoming_merchandise_items"("incoming_merchandise_id");

-- CreateIndex
CREATE INDEX "incoming_merchandise_items_product_id_idx" ON "public"."incoming_merchandise_items"("product_id");

-- CreateIndex
CREATE INDEX "returns_sale_id_idx" ON "public"."returns"("sale_id");

-- CreateIndex
CREATE INDEX "returns_status_id_idx" ON "public"."returns"("status_id");

-- CreateIndex
CREATE INDEX "return_items_return_id_idx" ON "public"."return_items"("return_id");

-- CreateIndex
CREATE INDEX "return_items_sale_item_id_idx" ON "public"."return_items"("sale_item_id");

-- CreateIndex
CREATE INDEX "return_items_product_id_idx" ON "public"."return_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_closures_closure_number_key" ON "public"."cash_closures"("closure_number");

-- CreateIndex
CREATE INDEX "cash_closures_date_idx" ON "public"."cash_closures"("date");

-- CreateIndex
CREATE INDEX "cash_closures_status_idx" ON "public"."cash_closures"("status");

-- CreateIndex
CREATE INDEX "cash_closure_payments_cash_closure_id_idx" ON "public"."cash_closure_payments"("cash_closure_id");

-- CreateIndex
CREATE INDEX "cash_closure_payments_payment_method_id_idx" ON "public"."cash_closure_payments"("payment_method_id");

-- CreateIndex
CREATE INDEX "cash_closure_denominations_cash_closure_id_idx" ON "public"."cash_closure_denominations"("cash_closure_id");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_types_name_key" ON "public"."promotion_types"("name");

-- CreateIndex
CREATE INDEX "promotions_active_start_date_end_date_idx" ON "public"."promotions"("active", "start_date", "end_date");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_codes_code_key" ON "public"."promotion_codes"("code");

-- CreateIndex
CREATE INDEX "promotion_codes_code_idx" ON "public"."promotion_codes"("code");

-- CreateIndex
CREATE INDEX "promotion_codes_promotion_id_idx" ON "public"."promotion_codes"("promotion_id");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_products_promotion_id_product_id_key" ON "public"."promotion_products"("promotion_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_categories_promotion_id_category_id_key" ON "public"."promotion_categories"("promotion_id", "category_id");

-- CreateIndex
CREATE INDEX "sale_promotions_sale_id_idx" ON "public"."sale_promotions"("sale_id");

-- CreateIndex
CREATE INDEX "sale_promotions_promotion_id_idx" ON "public"."sale_promotions"("promotion_id");

-- AddForeignKey
ALTER TABLE "public"."suppliers" ADD CONSTRAINT "suppliers_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."suppliers" ADD CONSTRAINT "suppliers_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "public"."statuses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."suppliers" ADD CONSTRAINT "suppliers_payment_terms_id_fkey" FOREIGN KEY ("payment_terms_id") REFERENCES "public"."payment_terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."products" ADD CONSTRAINT "products_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."products" ADD CONSTRAINT "products_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "public"."stock_statuses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."alerts" ADD CONSTRAINT "alerts_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "public"."alert_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."alerts" ADD CONSTRAINT "alerts_priority_id_fkey" FOREIGN KEY ("priority_id") REFERENCES "public"."alert_priorities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."alerts" ADD CONSTRAINT "alerts_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."alerts" ADD CONSTRAINT "alerts_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "public"."statuses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."alerts" ADD CONSTRAINT "alerts_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sales" ADD CONSTRAINT "sales_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sales" ADD CONSTRAINT "sales_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "public"."sale_statuses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sale_items" ADD CONSTRAINT "sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sale_items" ADD CONSTRAINT "sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."purchase_logs" ADD CONSTRAINT "purchase_logs_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."purchase_logs" ADD CONSTRAINT "purchase_logs_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."incoming_merchandise" ADD CONSTRAINT "incoming_merchandise_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."incoming_merchandise" ADD CONSTRAINT "incoming_merchandise_registered_by_fkey" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."incoming_merchandise_items" ADD CONSTRAINT "incoming_merchandise_items_incoming_merchandise_id_fkey" FOREIGN KEY ("incoming_merchandise_id") REFERENCES "public"."incoming_merchandise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."incoming_merchandise_items" ADD CONSTRAINT "incoming_merchandise_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."returns" ADD CONSTRAINT "returns_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."returns" ADD CONSTRAINT "returns_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "public"."return_statuses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."return_items" ADD CONSTRAINT "return_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."return_items" ADD CONSTRAINT "return_items_sale_item_id_fkey" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."return_items" ADD CONSTRAINT "return_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."cash_closure_payments" ADD CONSTRAINT "cash_closure_payments_cash_closure_id_fkey" FOREIGN KEY ("cash_closure_id") REFERENCES "public"."cash_closures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."cash_closure_payments" ADD CONSTRAINT "cash_closure_payments_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."cash_closure_denominations" ADD CONSTRAINT "cash_closure_denominations_cash_closure_id_fkey" FOREIGN KEY ("cash_closure_id") REFERENCES "public"."cash_closures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."promotions" ADD CONSTRAINT "promotions_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "public"."promotion_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."promotion_codes" ADD CONSTRAINT "promotion_codes_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."promotion_products" ADD CONSTRAINT "promotion_products_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."promotion_products" ADD CONSTRAINT "promotion_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."promotion_categories" ADD CONSTRAINT "promotion_categories_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."promotion_categories" ADD CONSTRAINT "promotion_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sale_promotions" ADD CONSTRAINT "sale_promotions_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sale_promotions" ADD CONSTRAINT "sale_promotions_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
