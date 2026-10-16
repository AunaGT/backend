-- Contactos: persona individual vs empresa (misma tabla suppliers)

CREATE TYPE "ContactEntityKind" AS ENUM ('PERSON', 'ORGANIZATION');

ALTER TABLE "suppliers" ADD COLUMN "entity_kind" "ContactEntityKind" NOT NULL DEFAULT 'ORGANIZATION';
