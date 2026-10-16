# Reconciliación segura de migraciones — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans para implementar este plan tarea por tarea en la sesión actual. Steps use checkbox (`- [ ]`) syntax for tracking. No delegar implementación. Una revisión independiente al final de la preparación local, antes de promover el historial.

**Goal:** Reconciliar el historial de Supabase sin perder datos, instalar y ensayar una baseline fiel, y desbloquear la migración pendiente de métodos de pago por empresa.

**Architecture:** Capturar el estado real previo a pagos, preservando SQL propio y un respaldo privado. Ensayar la nueva cadena en un esquema vacío de la misma Supabase, archivar el historial remoto sin editar sus filas y registrar la baseline mediante Prisma. Aplicar pagos solo después de comprobar equivalencia, recuperación y ausencia de otros escritores.

**Tech Stack:** Node.js CommonJS, Prisma 6.14, PostgreSQL 17.4, herramientas PostgreSQL instaladas (`pg_dump`/`pg_restore` 18.6 y `psql`), `node:test`. Sin dependencias nuevas, sin otra instancia y sin base local.

**Spec:** `/home/DiegoPatzan/Documents/CODE/Auna/deposito-backend/docs/superpowers/specs/2026-10-15-reconciliacion-migraciones-design.md` — aprobado para planificar mediante «continua» después de su presentación.

## Global Constraints

- Misma Supabase de desarrollo y mismas carpetas. No crear otro proyecto, otra instancia ni otra base local.
- No copiar datos de negocio al ensayo; solo estructura, catálogos de sistema y datos sintéticos propios de la prueba.
- No usar `migrate reset`, `db push`, `TRUNCATE`, borrado de negocios, semilla completa ni edición de filas históricas para resolver divergencias.
- La baseline representa el estado real hasta `202610150001_company_roles`; `202610150002_company_payment_methods` permanece separada e idéntica byte por byte.
- El SQL ejecutable excluirá `_prisma_migrations` y cualquier historial administrativo; esa tabla la administra Prisma.
- Conservar `product_lots.is_system_generated`, la expresión generada de `roles.name_key`, los resguardos compuestos y las reglas actuales de cascadas/nulabilidad.
- No ejecutar `prisma/seed.js` sobre Supabase existente, ni certificar el onboarding general a partir de un ensayo estructural.
- Conservar la tabla histórica en `auna_migration_audit._prisma_migrations_20261015`, sin borrar, alterar ni fabricar sus filas, checksums, estados o fechas.
- No ejecutar el SQL de creación de la baseline contra tablas de negocio existentes.
- Respaldos, datos de negocio, secretos y recibos de ejecución van en una carpeta privada local con permisos restringidos y fuera de Git.
- La limpieza solo elimina el esquema QA exacto registrado por esa ejecución; nunca por prefijo ni en `public`, `auth`, `storage` o `auna_migration_audit`.
- Un fallo mantiene Auna pausado. Después de aplicar pagos no volver al backend antiguo ni ejecutar una inversa improvisada.
- No push, PR ni merge. La revisión del plan precede a la implementación; no interpretar este documento como evidencia de ejecución.

## Review Focus

1. Un destino diferente, respaldo cambiado o escritor aparecido entre captura y promoción debe detenerse antes de mover metadata. Cubierto en tareas 1 y 5.
2. Referencias a `public` dentro de cuerpos de función, `regclass`, comandos psql o privilegios no deben escapar del ensayo; `public.gin_trgm_ops` es una dependencia externa legítima, no una tabla Auna que se deba renombrar. Cubierto en tareas 2 y 4.
3. Una instalación vacía debe conservar SQL propio y catálogos introducidos por migraciones, aunque el modelo Prisma no los represente. Cubierto en tareas 2, 3 y 4.
4. Un corte después de un commit remoto pero antes de recibir confirmación no debe repetir un traslado ni perder el historial original. Cubierto en tareas 5 y 6.
5. Una segunda ejecución, o una prueba negativa aceptada inesperadamente, no debe modificar preferencias ni dejar datos financieros sin limpiar. Cubierto en tareas 4, 6 y 7.

## Directorios y responsabilidades

Backend `B`: `/home/DiegoPatzan/Documents/CODE/Auna/deposito-backend`.
Frontend `F`: `/home/DiegoPatzan/Documents/CODE/Auna/deposito-frontend`.

| Archivo | Responsabilidad |
| --- | --- |
| `B/scripts/migrations/inventory.js` | Inventario PostgreSQL, equivalencia, huellas de filas e identidad de destino. Solo lectura. |
| `B/scripts/migrations/baselineSql.js` | Preparación de SQL de dump, destinos y aislamiento estricto del ensayo. Sin conexión ni ejecución. |
| `B/scripts/migrations/history.js` | Estados de promoción, traslado transaccional e inspección/reanudación del historial. |
| `B/scripts/reconcile-migrations.js` | CLI de captura, ensayo, promoción y comprobación; integra los tres archivos anteriores y herramientas instaladas. |
| `B/scripts/migrationFiles.js` | Resolución de SQL activo/archivado, checksums y bloqueo de deployers obsoletos. |
| `B/prisma/migrations/0_auna_baseline_20261015/` | Baseline estructural antes de pagos y manifiesto de objetos propios. |
| `B/prisma/migrations-archive/pre-baseline-20261015/` | Los 75 archivos anteriores, intactos, y manifiesto de procedencia. No ejecutable por deploy. |
| `B/tests/migrations.*.test.js` | Regresiones locales sin credenciales ni escrituras remotas. |
| `B/tests/migrations.baseline.dev.e2e.js` | Ensayo opt-in en esquema vacío de la Supabase actual. |
| `B/docs/DEPLOYMENT_AND_MIGRATIONS.md` | Procedimiento operativo actualizado después de la verificación. |

No construir una plataforma genérica de migraciones. Los nombres, fases y objetos autorizados corresponden a esta reconciliación.

## Task 1: inventario reproducible y respaldo verificable

**Files:** crear `scripts/migrations/inventory.js`, `scripts/reconcile-migrations.js` inicialmente solo con `capture`/`inspect`, `tests/migrations.inventory.test.js`. Consumir `scripts/salesDevTarget.js`, `src/config/loadEnv.js` y el sanitizador existente de `scripts/sales-drafts-deploy.js`, sin activar su `main`.

**Interfaces:**

- `connectionIdentity(url)` y `assertDevTarget(options)` ya existen. La primera identifica proyecto por host/usuario/base; comprobar por separado que DIRECT usa el puerto autorizado, no asumir que su hash incluye puerto. La captura solo lee la configuración actual y exige URLs PostgreSQL del mismo proyecto. Para cualquier fase escritora, `assertDevTarget` recibe host/base/identidad fijados en el recibo de captura y `approved: env.AUNA_BASELINE_DEV==='1'`; no obtiene su destino aprobado recalculándolo desde la URL que intenta validar. No modificar `.env` ni depender de aprobaciones persistidas de entregas anteriores.
- `captureInventory(db, schema)` devuelve `{tables, columns, constraints, indexes, sequences, functions, triggers, policies, grants, publications, extensions}`: arrays ordenados de definiciones completas, sin datos de filas ni OIDs ambientales.
- `compareInventory(actual, expected, {sourceSchema, targetSchema})` devuelve una lista explícita de diferencias; no transforma ni aplica SQL.
- `captureRows(db, schema, projections)` devuelve hashes y cantidades por tabla. La captura privada incluye nombres/tipos de columnas originales para comparar las mismas proyecciones tras pagos; nunca imprime filas.
- `capture` devuelve solo la ruta absoluta del recibo privado y un resumen sin secretos. `inspect --receipt /ruta/recibo.json` verifica integridad sin escribir.

- [ ] **1. Escribir regresiones de identidad, definiciones y cambios reales.** Eliminar un CHECK sin cambiar su nombre, un índice parcial o una política debe generar una diferencia. Cambiar el importe de una fila conservando su ID y cantidad debe cambiar su huella. Un respaldo de otro proyecto o con bytes modificados debe rechazarse.

```js
const test = require('node:test'), assert = require('node:assert/strict')
const { compareInventory, fingerprintRows } = require('../scripts/migrations/inventory')
test('definition changes cannot hide behind equal object counts', () => {
  const before = {constraints:[{table:'sales',name:'amount_check',definition:'CHECK (total >= 0)'}]}
  const after = {constraints:[{table:'sales',name:'amount_check',definition:'CHECK (total >= -1)'}]}
  assert.notDeepEqual(compareInventory(after,before,{sourceSchema:'public',targetSchema:'public'}),[])
})
test('same IDs and row count do not hide a changed payment', () => {
  assert.notEqual(fingerprintRows([{id:'R',amount:'10.00'}]),fingerprintRows([{id:'R',amount:'11.00'}]))
  assert.equal(fingerprintRows([{id:'B'},{id:'A'}]),fingerprintRows([{id:'A'},{id:'B'}]))
})
```

- [ ] **2. Ejecutar `node --test tests/migrations.inventory.test.js`.** Esperado inicial: fallo por módulo/funciones ausentes. No cargar `.env` ni abrir la base desde los tests locales.
- [ ] **3. Implementar lectura de catálogo y captura privada.** `fingerprintRows(rows)` calcula SHA-256 de JSON canónico de claves ordenadas y filas ordenadas, sin deducir igualdad de un simple count. En remoto, obtener filas en una transacción de lectura con snapshot consistente y mantener los valores solo en memoria/flujo privado, no en logs. Fijar zonaUTC en esa transacción y obtener números/decimales como texto PostgreSQL canónico, no convertirlos a números JS que puedan perder precisión. Capturar las definiciones con `pg_get_constraintdef`, `pg_get_indexdef`, `pg_get_functiondef`, `pg_get_triggerdef`, `pg_get_expr`, catálogos de ACL, `pg_policies`, `pg_publication_tables` y `pg_extension`. Incluir validación diferida/`NOT VALID`, generadas, identidad, RLS forzada, dueño del objeto como metadata ambiental separada y permisos de funciones.

El recibo privado tendrá `formatVersion:1`, `runId` UUID, `identity`, `target:{host,database,directPort}`, `createdAt`, `historyOid`, hash del historial completo, checksum del dump, checksums de SQL activo, inventario y huellas de las columnas originales. Crear carpeta con `mkdtemp`/modo0700 y archivos0600; rechazar rutas de respaldo dentro de cualquier repositorio, symlinks y destinos existentes. No añadir una credencial al recibo.

```js
// Solo estas variables pasan a los binarios PostgreSQL, nunca una URL en argv.
function postgresEnv(rawUrl, baseEnv) {
  const u = new URL(rawUrl)
  return {...baseEnv,PGHOST:u.hostname,PGPORT:u.port||'5432',
    PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),
    PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGSSLMODE:'require',PGCONNECT_TIMEOUT:'15'}
}
```

Reutilizar el patrón de respaldo existente, añadiendo timeout explícito, captura consistente y validación de todos los objetos esperados. Dentro de una transacción `REPEATABLE READ READ ONLY`, exportar `pg_export_snapshot()` y ejecutar el dump con `--snapshot` mientras esa conexión siga viva. El respaldo completo de `public` se genera como custom-format; `pg_restore --list` debe incluir datos de todas sus tablas Auna e historial. La estructura sin datos se captura con estos argumentos, con stdout privado:

```js
const schemaArgs = ['--schema-only','--schema=public','--no-owner','--no-acl',
  '--exclude-table=public._prisma_migrations','--no-publications','--no-subscriptions']
```

El dump no sustituye al inventario de ACL/publicaciones, que sus flags excluyen. Comprobar que no contiene COPY/INSERT de negocios. Registrar versiones de herramientas y servidor. Toda salida de error se sanitiza; exigir integridad de dump e inventario antes de habilitar una fase escritora. No ejecutar una restauración de clientes para declarar el respaldo «probado».

- [ ] **4. Añadir y ejecutar tests de respaldo cambiado, destino/puerto distintos, snapshot/exportación fallida, dump incompleto y sanitización.** Los dobles sustituyen solo conexión/procesos externos y permiten observar que ningún DDL se emitió. Testear el orden: un fallo previo impide el siguiente proceso. Esperado final: todas las regresiones verdes.
- [ ] **5. Ejecutar la captura de solo lectura sobre Supabase autorizada.**

```sh
node scripts/reconcile-migrations.js capture
```

Esperado: recibo privado verificable, checksums existentes iguales y solo pagos pendiente. Si aparece otro cambio o hay procesos Auna activos, registrar y coordinar su pausa antes de las fases escritoras; no detener otros procesos. La captura no ejecuta migraciones.
- [ ] **6. Verificar y guardar el entregable.**

```sh
node --test tests/migrations.inventory.test.js
npm run test:unit
git diff --check
git add scripts/migrations/inventory.js scripts/reconcile-migrations.js tests/migrations.inventory.test.js
git commit -m "feat(migrations): capture verifiable schema and private backup"
```

## Task 2: SQL fiel, dependencias e aislamiento cerrado

**Files:** crear `scripts/migrations/baselineSql.js`, `tests/migrations.baseline-sql.test.js`; ampliar CLI con `prepare` y los manifiestos estructurales de la baseline. Todavía no mover la cadena activa ni tocar el historial remoto.

**Interfaces:** `compileBaseline(dumpSql, inventory)` devuelve `{sql, environmentSql, objects, checksum}`; `compileRehearsal(sql, {schema, inventory, artifactChecksum})` devuelve SQL aislado; `assertQaSchema(name)` solo admite `auna_baseline_qa_` seguido de 32 caracteres hexadecimales. SQL y manifiestos producidos son artefactos generados; su procedencia y checksum se revisan antes de versionar.

- [ ] **1. Escribir tests que fallen por las funciones ausentes.** Deben probar statements completos, sin partir cuerpos por sus puntos y coma.

```js
const test=require('node:test'),assert=require('node:assert/strict')
const {compileRehearsal,assertQaSchema}=require('../scripts/migrations/baselineSql')
test('cleanup and rehearsal cannot target shared schemas',()=>{
  for(const name of ['public','auth','storage','auna_migration_audit','auna_baseline_qa_'])
    assert.throws(()=>assertQaSchema(name),{code:'BASELINE_SCHEMA_INVALID'})
})
test('connection meta commands are never executable rehearsal input',()=>{
  assert.throws(()=>compileRehearsal('\\connect other_database',{schema:'auna_baseline_qa_'+'a'.repeat(32),inventory:{}}),{code:'BASELINE_SQL_UNSUPPORTED'})
})
```

Añadir fixtures SQL pequeños que incluyan: `CREATE FUNCTION` con dos sentencias y un literal con punto y coma; referencia a tabla Auna calificada dentro del cuerpo; `'public.sales'::regclass`; referencia a `public.gin_trgm_ops` perteneciente a `pg_trgm`; comentario con texto engañoso; identificador con comillas escapadas; intento de `ALTER PUBLICATION`, `SET ROLE` o escritura a `auth.users`. Derivar el destino esperado manualmente.
- [ ] **2. Ejecutar `node --test tests/migrations.baseline-sql.test.js` y observar los fallos.**
- [ ] **3. Implementar compilación específica del dump controlado.** Usar un escáner de SQL que reconozca comentarios, identificadores entre comillas, strings/escapes y bloques dollar-quoted; no `.split(';')` ni reemplazos globales de `public`. Aceptar solamente las clases de sentencias del dump inventariado y la migración de pagos cuyo hash está fijado. Una construcción nueva o dinámica no comprobable falla cerrada.

Reglas concretas:

- Quitar únicamente la pareja coincidente `\restrict`/`\unrestrict` del encabezado/final pg_dump; rechazar cualquier otro metacomando. Normalizar sus valores aleatorios para obtener artefactos reproducibles.
- Excluir historial Prisma, comentarios/CREATE del esquema compartido y objetos de extensiones. Emitir `CREATE SCHEMA IF NOT EXISTS "public"` para la baseline canónica, nunca DROP SCHEMA.
- Mantener DDL, funciones y resguardos completos. No usar `migrate diff` como generador exclusivo porque pierde SQL propio.
- Reescribir destinos Auna según identidad de objeto del inventario, también dentro de cuerpos conocidos. Reescribir o rechazar literales `regclass` que señalen objetos Auna; nunca dejarlos apuntando a negocio real. Preservar referencias externas identificadas, como el opclass de `pg_trgm`, solo como dependencias de lectura.
- En QA fijar `search_path` al esquema QA, `pg_catalog` y dependencias comprobadas; no incluir `public` como fallback de tablas Auna. No ejecutar ACL a roles de clientes, cambios de publicaciones, extensiones ni privilegios de plataforma durante el ensayo.
- Separar ACL/publicaciones canónicas en `environmentSql`, inventariadas y verificadas por lectura. Para una instalación nueva solo se renderizan grants a roles Supabase existentes que coincidan con lo observado; una dependencia/rol desconocido bloquea, no genera permisos amplios por defecto. La baseline registrada en la base existente no aplica esos grants.
- Toda excepción ambiental queda identificada por objeto y definición. Un manifiesto no puede autorizar una omisión genérica de funciones, políticas o índices.

```js
function assertQaSchema(name) {
  if (!/^auna_baseline_qa_[0-9a-f]{32}$/.test(name))
    throw Object.assign(new Error('Esquema de ensayo inválido'),{code:'BASELINE_SCHEMA_INVALID'})
  return name
}
```

El ejecutor usa `psql -X --no-password --set ON_ERROR_STOP=1` y SQL completo, no `$executeRaw` por fragmentos partidos. La entrada ya compilada debe validarse íntegra antes de enviar su primera sentencia. No declarar seguro un archivo solo porque su primera tabla tiene el prefijo QA.

La baseline canónica versionada incorpora `sql` y `environmentSql` en secciones identificadas por el manifiesto: un deploy nuevo de Prisma solo ejecuta `migration.sql`, no archivos auxiliares. La variante QA excluye las sentencias de plataforma y compara esas definiciones por lectura separada. Su manifiesto registra exactamente qué se excluyó y por qué; no se puede perder ACL o publicación en una instalación nueva por separarlas para el ensayo.

La candidata ya incorpora el INSERT idempotente de `Borrador` mostrado en tarea3 como bootstrap de sistema declarado; su checksum abarca esa sentencia. La publicación de tarea3 no modifica una candidata ensayable agregando datos después de calcularle su hash. Cualquier otro INSERT detectado en el dump de solo estructura se rechaza.
- [ ] **4. Preparar la baseline candidata a partir de la captura, todavía fuera de la carpeta activa.**

```sh
node scripts/reconcile-migrations.js prepare --receipt /ruta/privada/devuelta-por-capture/recibo.json
```

El argumento es la ruta absoluta real obtenida en tarea1, no crear literalmente ese directorio de ejemplo. El comando valida recibo/checksums y devuelve una candidata privada con SQL y manifiesto. Esperado: sin datos, historial ni extensión recreada; objetos propios presentes y pagos ausente de esa candidata. No marcar nada como aplicado.
- [ ] **5. Ejecutar las regresiones y suite antes del commit.**

```sh
node --test tests/migrations.baseline-sql.test.js tests/migrations.inventory.test.js
npm run test:unit
git diff --check
git add scripts/migrations/baselineSql.js scripts/reconcile-migrations.js tests/migrations.baseline-sql.test.js
git commit -m "feat(migrations): compile faithful isolated baseline SQL"
```

## Task 3: nueva cadena y compatibilidad de consumidores históricos

**Files:** crear `scripts/migrationFiles.js`, `tests/migrations.archive.test.js`, baseline/manifiestos y archivo histórico; modificar consumidores directos en `tests/hr.documents.schema.test.js`, `tests/returns.persistence.test.js`, `tests/helpers/appointmentsTestDb.cjs`, `tests/services.migration.e2e.js`, `tests/appointments.commercial-deploy.e2e.js`, `tests/promotions.coupon-concurrency.e2e.js`, `tests/orders.migration.sql`; revisar también `scripts/apply-returns-migration.js`, `scripts/apply-hr-documents-migration.js`, `scripts/appointments-staging.js`, `scripts/coupon-staging.js`, `scripts/sales-drafts-deploy.js`. Repetir búsqueda completa de referencias para no depender solo de esta lista.

**Interfaces:** `migrationSqlPath(name, {historical:false})` resuelve solamente un archivo activo por defecto; `historical:true` permite el archivado cuyo checksum coincide con su manifiesto. `assertActiveMigration(name)` lanza `MIGRATION_ARCHIVED` si es obsoleta. Ningún getter mueve archivos ni escribe la base.

- [ ] **1. Escribir pruebas en un árbol temporal de archivos con dos migraciones ficticias y checksums conocidos.** Cubrir lectura activa, lectura histórica explícita, path traversal, archivo cambiado, duplicación en ambos árboles y rechazo de un deployer obsoleto antes de abrir conexión.

```js
test('archived migration is not a new deployment target',()=>{
  assert.throws(()=>assertActiveMigration('202610150001_company_roles'),{code:'MIGRATION_ARCHIVED'})
})
```

Ejecutar primero contra la función ausente. Los tests del resolver aceptan `root` de fixture al construirlo, no escriben archivos en producción. La prueba de CLI corre con credenciales ficticias y verifica el diagnóstico de archivo, no un fallo de red.
- [ ] **2. Archivar mecánicamente los 75 directorios previos con sus bytes intactos y generar el manifiesto de procedencia.** La operación debe rechazar una carpeta de destino existente. Mantener `migration_lock.toml` activo y el archivo de pagos sin cambios. Copiar la candidata revisada completa (estructura y sentencias ambientales declaradas) a `prisma/migrations/0_auna_baseline_20261015/migration.sql`; el manifiesto no contiene recibos privados ni datos.

El bootstrap de catálogos de migraciones históricas se inventaría explícitamente. La migración archivada de borradores introducía este dato de sistema; comprobar que la candidata de tarea2 ya lo conserva, sin añadir una segunda copia al publicarla:

```sql
INSERT INTO "public"."sale_statuses" ("name")
VALUES ('Borrador') ON CONFLICT ("name") DO NOTHING;
```

No copiar los INSERT históricos que reasignaban ventas, trasladaban existencias o creaban empresas de migración. Son transformaciones de datos previos, no prerrequisitos de una instalación vacía. El SQL de pagos ya inicializa cuatro medios básicos; no duplicar esa lógica en la baseline anterior a pagos.
Los checksums de la captura original no se reemplazan cuando cambia la cadena local deliberadamente: añadir un registro de artefactos de fase que vincule su hash inmutable con el manifiesto del archivo, la baseline candidata y el SQL de pagos original. La comprobación posterior exige la correspondencia completa captura→archivo y candidata→cadena activa; no acepta actualizar a mano la huella de origen para ocultar una modificación.

- [ ] **3. Adaptar lectores y bloquear ejecutores antiguos.** Los tests históricos usan el resolver con `historical:true` y mantienen sus asserts anteriores. Los deployers lo comprueban antes de inicializar clientes/conexiones. Guardar intactas funciones importadas por tests; no activar su `main` al importarlas. Eliminar rutas ejecutables que apunten a archivos borrados, sin inventar un SQL antiguo que nunca estuvo en la cadena local.
- [ ] **4. Clasificar y alinear metadata Prisma sin cambiar la base.** Añadir `ProductLot.is_system_generated Boolean @default(false)` según la columna real observada. Representar `roles.name_key` como `String? @default(dbgenerated()) @db.Text`, manteniendo la expresión real solo en SQL y sus checks. Ajustar nombres `map`, `onDelete` y `onUpdate` a definiciones reales donde Prisma lo permite. No copiar el diff destructivo observado.

Registrar cada diferencia no representable como objeto concreto en el manifiesto, con su definición y razón. Testear que una diferencia adicional no declarada sigue fallando. Un cambio de tipos, semántica o permisos fuera de la especificación mantiene el despliegue pausado.
- [ ] **5. Comprobar archivos y contratos.**

```sh
node --test tests/migrations.archive.test.js tests/hr.documents.schema.test.js tests/returns.persistence.test.js tests/sales.deploy.test.js tests/promotions.coupon-migration.test.js
npm run test:unit
npm run test:modules
node scripts/prisma-cli.js validate
git diff --check
rg -n 'prisma/migrations|migration.sql' scripts tests
```

Esperado: todas las lecturas antiguas resueltas o bloqueadas con diagnóstico deliberado; pagos conserva su checksum; Prisma válido. No generar todavía el cliente de runtime que asumiría pagos instalados.
- [ ] **6. Commit de la cadena y sus consumidores.** Añadir explícitamente los archivos de esta tarea, incluidos los movimientos detectados por Git, y revisar `git diff --cached --stat` y `--check` antes de `git commit -m "refactor(migrations): archive legacy chain and adopt audited baseline"`. Nunca usar `git add .` para arrastrar respaldos.

## Task 4: ensayo real desde vacío, bootstrap y limpieza

**Files:** crear `tests/migrations.baseline.dev.e2e.js`, ampliar `scripts/reconcile-migrations.js` con `rehearse`; ampliar `tests/migrations.baseline-sql.test.js` con guardas locales de ejecución y limpieza.

**Interfaces:** `rehearse --receipt <absoluta>` exige `AUNA_BASELINE_DEV=1`, identidad original y recibo íntegro; devuelve recibo con `qaSchema`, hashes de artefactos, resultados y `qaCleaned:true`. El esquema procede de UUID aleatorio registrado antes del CREATE. Una falla al limpiar impide promover. El test opt-in usa timeout900000ms y los procesos hijos tienen sus propios límites; se mantiene la comunicación con el usuario mientras ejecuta en segundo plano.

- [ ] **1. Testear guardas antes de conexión.**

```js
test('rehearsal requires opt-in before opening a database',async()=>{
  let opened=0
  await assert.rejects(runRehearsal({env:{},open:()=>{opened++}}),{code:'BASELINE_OPT_IN_REQUIRED'})
  assert.equal(opened,0)
})
```

`runRehearsal({env,receiptPath,open})` es el cuerpo exportado de la CLI; `open` sustituye solo el I/O en el test. Los tests de limpieza verifican que UUID ajeno, recibo alterado o contenido inesperado no emiten DROP. Observar RED antes de implementar.
- [ ] **2. Implementar ensayo con el SQL real.** Validar todo antes de crear esquema. Generar variante QA de baseline y pagos con el compilador. En un recibo privado guardar las rutas, hashes y esquema exacto. Ejecutar Prisma CLI en procesos hijos con copias de `DATABASE_URL`/`DIRECT_URL` que solo cambian `?schema=...`; nunca editar `.env` ni el entorno global. La variante de esquema Prisma de ensayo y sus migraciones son artefactos temporales privados; el generador no apunta a `node_modules`.

En esta tarea se prueba instalación nueva: `migrate deploy --schema <schema-de-ensayo>` aplica baseline y pagos; segundo deploy no hace cambios. El recibo intermedio registra `installation:true`, `historyRecovery:false` y `qaCleaned:true`; por sí solo no habilita promoción. La tarea5 amplía y vuelve a ejecutar el ensayo con historial sintético, sin crear una dependencia circular para completar la tarea4.

No generar el cliente principal para ensayar. Usar SQL y Prisma CLI; la integración de servicios reales usará el cliente generado después de migrar `public`.
- [ ] **3. Escribir y ejecutar casos SQL de fidelidad con fixtures sintéticos propios.** Usar `INSERT ... RETURNING id` y UUIDs registrados, no IDs de usuarios/clientes reales. Cubrir:

- `roles.name_key` se calcula al cambiar `name`, y el nombre reservado de administrador local se rechaza.
- Un SERVICE válido no requiere proveedor, y un bien sin proveedor o una cantidad incompatible se rechaza.
- Los triggers de snapshots completan el nombre/unidad de líneas desde el producto; alterar el tipo comercial se rechaza.
- Un medio privado de empresaB no se asocia a empresaA, el nombre normalizado colisiona dentro de A y no entre A/B.
- El guard de venta completada rechaza POS con método nulo; la excepción de Agenda requiere compromisos realmente cubiertos y el mismo cliente/sucursal.
- Los CHECKs, índices parciales, funciones y triggers obtenidos del esquema QA coinciden en definición con baseline/pagos esperados. Políticas y grants se comparan por separado sin exponer QA ni añadirlo a Realtime.

Cada intento negativo usa la utilidad `expectDatabaseRejection` ya existente o una transacción SQL que fuerza rollback incluso si la operación pasó. Si requiere modelos no generados aún, usar la misma semántica con `$transaction` y consultas raw, no silenciar errores Prisma.
- [ ] **4. Ejecutar opt-in sobre la Supabase autorizada.**

```sh
AUNA_BASELINE_DEV=1 node --test tests/migrations.baseline.dev.e2e.js
```

La ruta absoluta del recibo se pasa por `AUNA_BASELINE_RECEIPT` en ese proceso. Sin opt-in, el test SKIP no cuenta como ensayo aprobado. Esperado con opt-in: todos los casos pasan, negocio real sin cambios y `qaCleaned:true`. Falla de aislamiento o limpieza detiene el plan antes de tocar el historial.
- [ ] **5. Guardar resultado local sin publicar recibos privados.**

```sh
node --test tests/migrations.baseline-sql.test.js tests/migrations.inventory.test.js
npm run test:unit
git diff --check
git add scripts/reconcile-migrations.js tests/migrations.baseline.dev.e2e.js tests/migrations.baseline-sql.test.js
git commit -m "test(migrations): rehearse baseline safely on current Supabase"
```

## Task 5: promoción recuperable y revisión antes de escrituras de historial

**Files:** crear `scripts/migrations/history.js`, `tests/migrations.history.test.js`; ampliar CLI con `promote-history`, `apply-payments`, `inspect`, `recover-history` y la reanudación; extender el ensayo de tarea4.

**Interfaces:**

- `inspectHistory(db, receipt)` devuelve `CAPTURED`, `ARCHIVED`, `BASELINED` o `PAYMENTS_APPLIED`, derivado de objetos/hashes remotos, no solo del archivo local.
- `archiveHistory(db, receipt)` mueve transaccionalmente la tabla original si sus OID/hash y el destino son los esperados. No actualiza sus filas.
- `recoverHistory(db, receipt)` solo vuelve al estado anterior a pagos si demuestra ausencia de cambios posteriores; conserva cualquier nueva tabla histórica en un nombre administrativo único. Si hay objetos desconocidos o pagos aplicado, devuelve `BASELINE_RECOVERY_REVIEW_REQUIRED` sin mover/borrar nada.
- `promote-history --receipt <absoluta>` exige ensayo completo/limpio, respaldo verificado, aprobación de destino y ventana sin escritores. Registra la baseline mediante Prisma, no insertando filas manualmente.
- `withMigrationGate(gateDb, work)` mantiene el lock administrativo en una conexión fijada por una transacción dedicada; `work` usa otra conexión/cliente para DDL y los procesos hijos Prisma.
- `apply-payments --receipt <absoluta>` exige opt-in y estado BASELINED (o PAYMENTS_APPLIED para reanudar), obtiene la misma guarda y ejecuta los comandos oficiales deploy/generate/status en ese orden. Se implementa y prueba aquí para que la revisión previa a promoción incluya todo el código escritor; la tarea6 solo lo ejecuta.

- [ ] **1. Escribir la matriz de fallos y observar RED.** Los dobles sustituyen catálogos/transacciones/CLI; no crean un estado ficticio que el inspector acepte sin comprobarlo.

```js
test('missing confirmation after remote commit resumes from remote state',async()=>{
  const db=historyFixture({remotePhase:'ARCHIVED',localPhase:'CAPTURED'})
  assert.equal(await inspectHistory(db,db.receipt),'ARCHIVED')
  await archiveHistory(db,db.receipt)
  assert.equal(db.historyMoveCount,0)
})
test('recovery refuses after a business migration has committed',async()=>{
  const db=historyFixture({remotePhase:'PAYMENTS_APPLIED',localPhase:'BASELINED'})
  await assert.rejects(recoverHistory(db,db.receipt),{code:'BASELINE_RECOVERY_REVIEW_REQUIRED'})
  assert.equal(db.destructiveStatements.length,0)
})
```

Crear `tests/helpers/migrationHistoryFixture.cjs`: simula únicamente el catálogo/DB y rollback, con historial original conocido, OID, hashes, schema administrativo y nuevo historial. No poner esa utilidad en código de producción. Cubrir también colisión administrativa, checksum/OID distintos, respaldo alterado, escritor detectado y falla de Prisma antes/después de crear el nuevo historial. Para `apply-payments`, probar que un recibo parcial/fase ajena no invoca hijos, un fallo de deploy impide generate y status, y una guarda perdida cancela al hijo en vez de seguir al siguiente.
- [ ] **2. Implementar estados y SQL acotado.** No usar un lock de sesión con llamadas Prisma sueltas: su pool puede devolver conexiones diferentes. Mantener el lock propio `auna:migrations:baseline:20261015` mediante `pg_try_advisory_xact_lock` en una transacción dedicada que solo ejecuta la guarda y comprobaciones de vida; DDL/Prisma CLI utilizan otro cliente. Esa transacción no consulta ni bloquea tablas Auna. Fijar `timeout:300000` y `maxWait:15000`, comprobar que sigue viva antes de cada fase y cada5s mientras corre un hijo, y cancelar procesos hijos si se pierde la guarda; nunca continuar bajo un lock expirado. Cada hijo de promoción tiene timeout120s. Liberar por commit/rollback en finally. Usar ejecución asíncrona de procesos con timeout, sin bloquear el control de vida de la guarda.

Comprobar sesiones/operaciones concurrentes con `pg_stat_activity`, identificando conexiones actuales y herramientas propias; si no hay permisos para comprobarlo o existen escritores no coordinados, detenerse. El lock propio no sustituye esa ventana ni bloquea mágicamente otras herramientas Prisma. Probar con una segunda conexión que el lock siga retenido durante el trabajo y quede libre al terminar.

En una transacción bloquear la tabla histórica, verificar recibo y destino, crear el esquema administrativo solo si no colisiona, fijar ACL restrictiva y mover:

```sql
ALTER TABLE public._prisma_migrations SET SCHEMA auna_migration_audit;
ALTER TABLE auna_migration_audit._prisma_migrations
  RENAME TO _prisma_migrations_20261015;
```

Comprobar filas, checksum y OID después del traslado. No emitir DELETE/UPDATE sobre el historial. El inspector distingue un traslado ya completado de un destino ajeno; los hashes esperados deben coincidir en ambos casos.

Después del commit, invocar el comando oficial:

```sh
node scripts/prisma-cli.js migrate resolve --applied 0_auna_baseline_20261015
```

Mantener la transacción de guarda durante el proceso hijo, sin locks de tabla que bloqueen a Prisma. Si la conexión cae, inspeccionar estado remoto antes de reintentar. El nuevo `public._prisma_migrations` lo crea Prisma. No inventar una fila de pagos.

`migrate status` intermedio puede salir con código1 por **solo pagos pendiente**; comprobar esa causa y la ausencia de divergencia/fallos mediante catálogo e informe nativo. No confundir todo código1 con un éxito ni exigir código0 antes de aplicar la migración pendiente.
- [ ] **3. Ejecutar pruebas de interrupción reales con historial sintético en QA.** Ampliar el ensayo de tarea4 y repetirlo: instalar baseline en un esquema QA nuevo vacío, añadir historial sintético y probar adopción. Usar nombres de historial derivados del esquema QA en su ámbito, sin escribir en `auna_migration_audit` real durante el ensayo. Inyectar cortes controlados antes/después del traslado y de `resolve`; comprobar reanudación y recuperación. Comprobar que una tabla nueva desconocida impide recuperación automática y no se elimina. El recibo final exige `installation:true`, `historyRecovery:true` y `qaCleaned:true`; un resultado parcial anterior se rechaza para promoción.
- [ ] **4. Ejecutar suites completas y solicitar una revisión independiente de todo el cambio local antes de promoción.**

```sh
npm run test:unit
npm run test:modules
node scripts/prisma-cli.js validate
git diff --check
```

Revisor de solo lectura: spec, este plan, rangos exactos B/F y evidencia local/QA; foco en aislamiento, estados de corte, ACL, SQL propio y límites de recuperación. Corregir críticos/importantes en una pasada con RED→GREEN y suite verde; no solicitar otra revisión para sustituir tests. Registrar menores diferidos. No promover si el ensayo o la revisión dejan un bloqueo de seguridad/datos.
- [ ] **5. Commit del mecanismo, todavía sin mover historial real.**

```sh
git add scripts/migrations/history.js scripts/reconcile-migrations.js tests/migrations.history.test.js tests/helpers/migrationHistoryFixture.cjs tests/migrations.baseline.dev.e2e.js
git diff --cached --check
git commit -m "feat(migrations): promote baseline with recoverable audited history"
```

## Task 6: promoción real, pagos e integración financiera

**Files:** no añadir otra migración. Usar CLI y pruebas anteriores; actualizar solo el registro de ejecución y las correcciones concretas que una comprobación demuestre necesarias.

**Interfaces:** recibo completo y vigente de tareas1–5; fases remotas comprobadas; migración de pagos original; fixture opt-in `tests/paymentMethods.company.dev.e2e.js` ya preparado. Consumir `apply-payments --receipt <absoluta>` ya implementado/revisado en tarea5. Esta tarea no añade código escritor después de la revisión de seguridad.

- [ ] **1. Revalidar antes de la primera escritura real del historial.** Confirmar mismo destino, respaldo íntegro, estructura/hash de negocio sin cambios, prueba QA limpia, revisión aprobada y ausencia de escritores. Repetir inventario de procesos/puertos. Pausar solo Auna si estaba activo; registrar el comando original y reiniciar únicamente esos procesos al final. Si cambió la fuente desde el ensayo, recapturar y repetir equivalencia; no retocar el recibo para que coincida.
- [ ] **2. Promover el historial y verificar estado intermedio.**

```sh
AUNA_BASELINE_DEV=1 node scripts/reconcile-migrations.js promote-history --receipt /ruta/privada/real/recibo.json
npm run migrate:status
```

El ejecutor sustituye la ruta por la absoluta real ya comprobada. Esperado: historial original íntegro/privado, baseline aplicada y únicamente pagos pendiente; ningún negocio cambiado. Si no se cumple, mantener pausa y usar `inspect`, no ejecutar deploy.
- [ ] **3. Aplicar pagos y generar el cliente de runtime bajo la misma guarda administrativa.**

```sh
AUNA_BASELINE_DEV=1 node scripts/reconcile-migrations.js apply-payments --receipt /ruta/privada/real/recibo.json
```

Ese comando ejecuta, en orden, `npm run migrate:deploy`, `npm run prisma:generate` y `npm run migrate:status`, con límites de tiempo y comprobación de vida de la guarda. No sustituye Prisma por SQL manual ni inserciones de historial. Registrar salida/código de cada hijo, no únicamente el resultado del último.

Esperado: SQL de pagos aplicado, cliente generado y estado nativo exit0 sin divergencias ni pendientes. Verificar tipos, columnas, asociación por empresa, clasificación básica y versión del guard, no solo el nombre de migración. Si hay error tras un commit desconocido, inspeccionar antes de repetir.
- [ ] **4. Ejecutar la integración financiera real ya preparada.**

```sh
AUNA_DEV_PAYMENT_METHOD_TESTS=1 node --test tests/paymentMethods.company.dev.e2e.js
```

Esperado: aislamiento A/B, unicidad, locks y desactivación concurrente, seed idempotente, rechazo POS/null y emisión real de Agenda con recibos mixtos/reintento sin dinero ni asientos duplicados. Los fixtures se limpian por IDs conocidos; verificar limpieza, no inferirla del finally. Un fallo exige diagnóstico y evidencia; no seguir operando con un backend incompatible.
- [ ] **5. Comparar negocio y repetir deploy.**

```sh
npm run migrate:deploy
npm run migrate:status
node scripts/reconcile-migrations.js inspect --receipt /ruta/privada/real/recibo.json
```

El comparador usa las proyecciones originales para `payment_methods`, donde se añadieron metadatos; verifica aparte los valores nuevos esperados y preferencias. Las demás filas originales deben coincidir. Permitir solo los incrementos monotónicos normales de secuencias usados por fixtures; no restaurar contadores hacia atrás para ocultar huecos. Comprobar que la segunda ejecución no cambia preferencias/configuración ni historial financiero.

Esperado: exit0, ningún QA residual, archivo histórico intacto, cambios limitados a los autorizados. No usar este resultado para afirmar que se probó una restauración completa de datos o que Storage/FEL/onboarding funcionan.
- [ ] **6. Registrar resultado real.** `docs/planning/2026-10-15-reconciliacion-migraciones-verificacion.md` recoge comandos/resultados, fases, hashes no secretos, limpieza y procesos. No versionar rutas privadas con contenido sensible, dumps, recibos completos ni datos de clientes. Si hubo un fallo, describir el punto exacto y mantener el plan sin completar en vez de imprimir éxito.

## Task 7: guía, comprobaciones finales y retorno al plan de pagos

**Files:** modificar `B/docs/DEPLOYMENT_AND_MIGRATIONS.md`, registro anterior y `F/docs/planning/2026-10-15-metodos-pago-por-empresa-verificacion.md`.

- [ ] **1. Actualizar la guía solo con hechos verificados.** Explicar cadena nueva, archivo, esquema administrativo, `migrate resolve` de baseline ya existente frente a deploy nuevo, comandos de inspección/recuperación, dependencias Supabase y límites de las semillas. Incluir que el ensayo vacío sustituye al clon previamente prohibido; no declarar que todas las instancias históricas quedaron reconciliadas por cambiar la de desarrollo.
- [ ] **2. Ejecutar comprobación final completa.**

```sh
# Backend
npm run test:unit
npm run test:modules
node scripts/prisma-cli.js validate
npm run migrate:status
git diff --check
# Frontend, desde F
node --test --test-concurrency=4 tests/*.test.cjs tests/*.test.mjs
npm run test:modules
npm run build
git diff --check
```

Esperado: suites verdes, Prisma válido y estado nativo sin divergencia. Mantener registrada la inestabilidad previa del test de cupones si reaparece; no ocultar errores ajenos ni aplicar cambios cosméticos fuera del alcance.
- [ ] **3. Restablecer solo los procesos Auna previamente activos y verificar lectura de API compatible.** `/health` debe corresponder a la rama/commit; comprobar el catálogo de medios con sesión normal y empresa activa, sin extraer credenciales. No modificar el backend antiguo para que ignore tablas nuevas.
- [ ] **4. Retomar la validación visual pendiente de pagos.** Si la aplicación estaba activa y se pudo reiniciar, revisar claro/oscuro/móvil y cambios de empresa, catálogo y formularios. Si no había servidores activos, no inventar uno bajo la autorización de reinicio: informar la revisión visual pendiente y pedir abrir Auna. Esto no impide registrar la reconciliación comprobada, pero mantiene la tarea9 de pagos incompleta hasta su validación.
- [ ] **5. Guardar documentación y entregar límites exactos.**

```sh
git add docs/DEPLOYMENT_AND_MIGRATIONS.md docs/planning/2026-10-15-reconciliacion-migraciones-verificacion.md
git diff --cached --check
git commit -m "docs(migrations): record verified baseline deployment and recovery"
```

En F, añadir y guardar únicamente su documento de verificación. No borrar el workspace de pagos mientras su tarea9 esté pendiente. Informar al usuario qué se aplicó, qué se conservó, dónde quedó el historial auditable y qué validaciones faltan, sin confundir código preparado con deploy ejecutado.

## Auto-revisión del plan

| Requisito del diseño | Cobertura |
| --- | --- |
| Captura fiel, respaldo privado, checksums y comparación por datos | 1, 6 |
| SQL propio, objetos no representables, extensión en public | 2, 3, 4 |
| Cadena nueva, archivo íntegro y consumidores antiguos | 3 |
| Catálogos de sistema sin copiar negocios ni semilla peligrosa | 3, 4 |
| Ensayo en misma Supabase, sin exposición a clientes y limpieza exacta | 2, 4 |
| Historial remoto conservado, estados de corte y recuperación | 5, 6 |
| Pagos separado, cliente coordinado e integración real idempotente | 6 |
| Revisión independiente, documentación y retorno a verificación visual | 5, 7 |

Contratos fijados: inventario devuelve definiciones; compilador no ejecuta; resolver no migra; inspector lee estado remoto; promotor exige recibo+ensayo; Prisma registra el historial nuevo. Los cinco riesgos de Review Focus tienen regresiones asignadas. Las rutas privadas en comandos son marcadores de argumento documentados: se sustituyen exclusivamente por rutas reales devueltas por la captura, nunca se crean directorios con esos nombres ni se resuelven mediante globs.

No se ha implementado este plan, creado QA, generado una baseline activa, trasladado historial ni aplicado pagos durante su redacción.

## Handoff

El usuario revisa este plan antes de ejecutar. Se conserva la ejecución directa ya elegida; no es necesario volver a escoger entre agentes y ejecución nativa. Su aprobación habilita la preparación local y las fases de Supabase descritas, con las detenciones de seguridad indicadas, no un reset, una semilla general ni una nueva instancia.
