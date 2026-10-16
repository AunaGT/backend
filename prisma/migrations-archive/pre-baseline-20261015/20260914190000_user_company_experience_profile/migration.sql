-- El perfil solo cambia la experiencia visual. La autorización continúa
-- dependiendo de roles/permisos y las funciones habilitadas por empresa.
CREATE TYPE "ExperienceProfile" AS ENUM ('CASHIER', 'MANAGER', 'OWNER', 'ADVANCED');

ALTER TABLE "user_companies"
ADD COLUMN "experience_profile" "ExperienceProfile";
