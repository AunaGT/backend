-- Contactos: distinguir proveedor vs cliente en tabla suppliers (sin renombrar tabla)

CREATE TYPE "SupplierPartyType" AS ENUM ('SUPPLIER', 'CUSTOMER');

ALTER TABLE "suppliers" ADD COLUMN "party_type" "SupplierPartyType" NOT NULL DEFAULT 'SUPPLIER';

CREATE INDEX "suppliers_party_type_idx" ON "suppliers"("party_type");
