
# Despliegue y migraciones

Este documento evita que el frontend, el backend y PostgreSQL queden en versiones distintas.

## Comandos autorizados

- Desarrollo local: `npm run migrate:dev`
- Consultar estado sin modificar la base: `npm run migrate:status`
- Producción o staging: `npm run migrate:deploy`
- Regenerar Prisma Client: `npm run prisma:generate`

Los comandos cargan primero `.env` y, por compatibilidad con la configuración local actual, también aceptan `env`. Ninguno de esos archivos debe versionarse.

No se debe ejecutar `prisma db push` en producción. Tampoco se debe usar `prisma migrate dev` contra la base publicada.

## Orden de una publicación

1. Confirmar que frontend y backend apuntan a la misma rama o release.
2. Ejecutar `npm run migrate:status` con las variables del entorno de destino.
3. Preparar el backend compatible sin ponerlo todavía a atender tráfico que requiera columnas nuevas; coordinar la ventana de escritura cuando corresponda.
4. Ejecutar `npm run migrate:deploy` y después `npm run prisma:generate` desde esa versión.
5. Activar el backend y verificar `/health`; debe responder la rama y el commit esperados además de `ok: true`.
6. Publicar el frontend compatible.
7. Probar inicio de sesión, `GET /api/modules` y una operación de lectura por módulo. Restablecer solo los procesos coordinados para esa publicación.

Publicar el frontend primero puede hacer que llame endpoints que el backend anterior todavía no tiene. En particular, la plataforma modular necesita `/api/modules`.

## Diagnóstico de disparidad

- `404` en `/api/modules`: el backend publicado todavía no contiene la plataforma modular.
- Migraciones pendientes: ejecutar `npm run migrate:deploy` desde el mismo commit que se publicará.
- Migración presente en la base pero ausente del repositorio: el despliegue está usando una rama anterior. No se debe borrar la migración de la base; se debe alinear la rama del backend.
- Esquema al día pero interfaz anterior: el dominio de producción continúa apuntando a `main` u otro deployment previo.

La migración `20260811110000_baseline_drift` es histórica. En una base que ya contenía esas tablas por un antiguo `db push`, se resolvió como aplicada; no debe ejecutarse manualmente otra vez.

## Historia heredada: reconciliación verificada en desarrollo

El 15 de octubre de 2026 se reconcilió la Supabase de desarrollo que el usuario identificó como base de pruebas. Esto no afirma que otra base histórica o producción estén reconciliadas.

La cadena ejecutable comienza en `0_auna_baseline_20261015`, seguida por `202610150002_company_payment_methods`. Las 75 migraciones locales anteriores están íntegramente archivadas en `prisma/migrations-archive/pre-baseline-20261015`, con checksums. Nunca devolverlas al directorio activo ni crear archivos vacíos para simular un historial limpio.

La tabla original de historial, con sus 100 registros y su identidad, se conserva en `auna_migration_audit._prisma_migrations_20261015`. No se editaron sus filas. El esquema administrativo está cerrado a clientes y marcado para identificar la ejecución propietaria. El nuevo historial fue creado por Prisma mediante `migrate resolve --applied 0_auna_baseline_20261015`; **no se ejecutó la baseline sobre tablas existentes**. Después se aplicó pagos y se generó el cliente. El estado nativo quedó actualizado y un segundo deploy no tuvo cambios.

El ensayo autorizado usó esquemas temporales vacíos de esa misma Supabase, sin otra instancia ni copia de clientes. Una pareja source/audit permitió probar los movimientos reales entre esquemas, recuperaciones repetidas, bloqueos y ausencia de colisiones de PK. Ambos namespaces exactos fueron eliminados. Este ensayo sustituye, para esta ejecución, el requisito anterior de una base clonada; no equivale a probar una restauración completa de datos.

Registro de resultados y límites: `docs/planning/2026-10-15-reconciliacion-migraciones-verificacion.md`.

### Inspección y recuperación de esta reconciliación

`scripts/reconcile-migrations.js inspect --receipt RUTA_ABSOLUTA_RECIBO` comprueba respaldo, artefactos e historial remoto. Distingue CAPTURED, ARCHIVED, BASELINED y PAYMENTS_APPLIED; no deduce la fase de un archivo local ni oculta entradas divergentes.

Los modos `promote-history`, `apply-payments` y `recover-history` requieren el recibo privado original, `--rehearsal` con un ensayo completo y limpio, `AUNA_BASELINE_DEV=1`, destino idéntico y `AUNA_BASELINE_REVIEW_HEAD` fijado al commit revisado. No recalcular esa aprobación automáticamente desde un destino o código que se intenta autorizar. El árbol debe estar limpio y no debe haber escritores concurrentes; las estadísticas deben ser visibles para todos los roles. La guarda permanece en una transacción dedicada y cancela procesos hijos si se pierde.

Antes de pagos, recuperación comprueba estructura/datos, conserva cualquier historial nuevo con nombre único y devuelve el original sin sobrescribir intentos anteriores. Solo reutiliza un esquema administrativo cuyo propietario, marca, ACL y contenido correspondan a la ejecución. Después de PAYMENTS_APPLIED rechaza la recuperación automática: conservar la pausa y diagnosticar una reparación hacia adelante; no volver a consumidores antiguos ni improvisar SQL inverso.

Ante un error de conexión o confirmación perdida, inspeccionar primero el estado remoto; no repetir ciegamente ni insertar filas manualmente en el historial. El respaldo y recibos están fuera de Git, con copia persistente privada en el directorio local de respaldos Auna. Si se pierde `/tmp`, recuperar primero sus rutas privadas originales desde esa copia, sin sobrescribir destinos desconocidos; los hashes de procedencia no se cambian para adaptar un recibo.

### Instancia Supabase nueva

En una base realmente vacía se ejecuta la cadena con `npm run migrate:deploy`, después `npm run prisma:generate` y `npm run migrate:status`. No marcar la baseline como aplicada sin instalarla. En otra base histórica, detenerse y reconciliar su historial/datos específicamente: no reutilizar el recibo de desarrollo.

Prerrequisitos de plataforma de esta baseline: roles Supabase `anon`, `authenticated`, `service_role` y migrador; publicación `supabase_realtime`; `pg_trgm` con los opclasses referenciados en `public`; dependencias `pgcrypto`/`uuid-ossp` en `extensions` según el inventario. No crear roles sustitutos ni mover extensiones administradas para saltar un fallo. ACL y publicaciones canónicas están incluidas en el SQL; en QA se verificaron aparte sin exponer sus tablas a clientes ni añadirlas a Realtime.

El manifiesto de la baseline enumera las definiciones SQL que Prisma no expresa completamente: CHECKs, índices especiales, columna generada, funciones/triggers, políticas y siete FK adicionales. No ejecutar automáticamente un diff de modelos que proponga borrarlas. Una diferencia adicional no declarada sigue siendo un fallo, no una excepción genérica de drift.

La baseline conserva el catálogo de sistema Borrador; pagos inicializa los cuatro medios básicos y preferencias por empresa. **No ejecutar la semilla general sobre datos existentes:** contiene limpieza de categorías, cambios de caja y una credencial administrativa heredada. Este despliegue no certifica el onboarding general de una instancia nueva; tampoco Storage, FEL ni integraciones externas.

## Fotos de contactos (esquema aplicado en staging)

La migración `20261008120000_contact_images` añade únicamente la columna nullable
`suppliers.image_storage_path`. No borra ni transforma datos existentes. El 8 de
octubre de 2026 se aplicó únicamente su SQL en staging con autorización explícita
del usuario y se registró mediante `migrate resolve --applied
20261008120000_contact_images`. Se comprobaron tipo VARCHAR(500), nulabilidad,
checksum y registro finalizado. Los conteos permanecieron en 69 contactos y 76
ventas; el controlador real de detalle de venta consultó una venta vinculada a
un cliente sin el error P2022 ni exponer la ruta interna de la imagen. La primera
comprobación encontró un fallo transitorio de conexión; el reintento completo
aprobó. No se aplicaron otras migraciones ni se modificaron registros de negocio.
No se ha aplicado esta migración a producción.

La aplicación puntual de imágenes del 8 de octubre no reconciliaba el historial.
La reconciliación posterior descrita arriba lo resolvió únicamente en la Supabase
de desarrollo autorizada. Antes de desplegar en otra base, revisar su historial y
aplicar la migración de forma controlada antes de atender consultas de contactos.
No usar `db push`, editar filas históricas ni forzar un deploy divergente.

El bucket configurado por el cliente se llama `contacts`. El backend usa las
credenciales de servicio existentes y entrega URLs firmadas con vigencia de una
hora, nunca rutas internas ni claves. Se recomienda mantener el bucket privado;
no se comprobó ni cambió su política real. Los objetos se normalizan a WebP y se
separan por empresa/contacto; los reemplazos solo limpian objetos de ese mismo
contacto tras confirmar la referencia en la base.

Verificación pendiente de integración: cargar una foto sintética, comprobarla en
listado/ficha/venta, reemplazarla y confirmar aislamiento entre empresas y
permisos. Las pruebas unitarias de multipart, validación, permisos, firma y
reemplazo usan dobles de base/storage y no realizan cargas reales.
