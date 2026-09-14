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
