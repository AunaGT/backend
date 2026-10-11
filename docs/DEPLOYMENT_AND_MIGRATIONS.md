
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
3. Publicar el backend.
4. Ejecutar `npm run migrate:deploy` como paso controlado del despliegue del backend.
5. Verificar `/health`; debe responder la rama y el commit esperados además de `ok: true`.
6. Publicar el frontend.
7. Probar inicio de sesión, `GET /api/modules` y una operación de lectura por módulo.

Publicar el frontend primero puede hacer que llame endpoints que el backend anterior todavía no tiene. En particular, la plataforma modular necesita `/api/modules`.

## Diagnóstico de disparidad

- `404` en `/api/modules`: el backend publicado todavía no contiene la plataforma modular.
- Migraciones pendientes: ejecutar `npm run migrate:deploy` desde el mismo commit que se publicará.
- Migración presente en la base pero ausente del repositorio: el despliegue está usando una rama anterior. No se debe borrar la migración de la base; se debe alinear la rama del backend.
- Esquema al día pero interfaz anterior: el dominio de producción continúa apuntando a `main` u otro deployment previo.

La migración `20260811110000_baseline_drift` es histórica. En una base que ya contenía esas tablas por un antiguo `db push`, se resolvió como aplicada; no debe ejecutarse manualmente otra vez.

## Historia heredada pendiente de reconciliar

La base publicada conserva nombres de migraciones anteriores al
`20260211233410_init` consolidado. Varias pueden recuperarse del historial Git,
pero devolverlas a `prisma/migrations` rompería una instalación nueva: primero
crearía las tablas antiguas y luego el `init` intentaría crearlas otra vez.

No inventar archivos vacíos, no editar `_prisma_migrations` y no restaurar las
migraciones antiguas dentro de la cadena ejecutable solo para hacer verde el
estado. La solución segura es preparar, en una base clonada, una nueva línea de
base que represente el esquema actual; validar tanto la base publicada como una
instalación vacía; y promover esa línea de forma controlada. Hasta completar
esa reconciliación, `migrate:status` seguirá marcando historia divergente y el
despliegue de nuevas migraciones debe permanecer pausado.

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

Esta aplicación puntual no reconcilia la historia heredada descrita arriba ni
habilita el despliegue general de migraciones. Antes de desplegar en producción,
reconciliar esa historia y aplicar la migración de forma controlada antes de que
el nuevo backend atienda consultas de contactos. No usar `db push`, no editar
manualmente la historia ni ejecutar todas las migraciones pendientes sin
resolver esa divergencia.

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
