# Traspaso de modularización — backend

## Estado actual

La primera frontera modular está completa para las 23 capacidades del ERP.
Cada código de `src/modules/platform/registry.js` tiene un manifiesto en
`src/modules/<code>/manifest.js`, y `src/modules/catalog.js` es el único
catálogo que consume `src/routes/index.js` para montar routers.

Los módulos con varios routers (`inventory` y `sales`) declaran `routes`.
Los demás pueden declarar `routePrefix` y `loadRouter`. `users` usa
`guardAtMount: false` porque `/auth/login`, refresh, logout y `/me` deben seguir
disponibles; sus operaciones administrativas aplican `requireModule('users')`
dentro del router. `quotes` expone además su router público antes de resolver el
tenant y valida la activación usando la empresa obtenida del token público.

No volver a agregar montajes de negocio directos en `src/routes/index.js`.
`/companies`, `/modules` y el agregado `/commercial-documents` son rutas de
plataforma y por eso permanecen explícitas.

## Dónde encontrar la autoridad

- Códigos, nombres y dependencias: `src/modules/platform/registry.js`.
- Manifiestos y routers públicos: `src/modules/catalog.js` y
  `src/modules/<code>/manifest.js`.
- Estado por empresa, caché y cambios de estado:
  `src/modules/platform/service.js`.
- Guards HTTP: `src/modules/platform/middleware.js`.
- API de administración: `src/modules/platform/routes.js`.
- Persistencia: modelo `CompanyModule` en `prisma/schema.prisma` y migraciones
  en `prisma/migrations`.
- Pruebas de contrato: `tests/modules.registry.test.js`.
- Reglas generales: `docs/MODULE_ARCHITECTURE.md`.

## Qué falta

Los módulos `dashboard`, `alerts`, `analytics`, `branches`, `config`,
`promotions`, `hr`, `payroll`, `returns`, `transfers`, `receivables`,
`inventory-count` y `merchandise` ya poseen sus routers/controllers dentro de
`src/modules`. RRHH publica sus validadores desde `src/modules/hr/index.js` y
Cartera publica su lógica desde `src/modules/receivables/index.js`; Nómina y
Ventas consumen esas fronteras en vez de importar internals.

Los manifiestos ya aíslan el montaje y la activación, pero los demás routers aún
apuntan a controllers y services legacy. La siguiente fase es mover propiedad
física, un módulo por PR, sin cambiar contratos HTTP:

1. Crear dentro del módulo `routes.js`, `application/`, `domain/`,
   `infrastructure/` y `tests/` únicamente cuando haya código real para mover.
2. Usar `dashboard`, `alerts` o `hr` como patrones ya terminados.
3. Continuar con `catalogs`, `users`, `contacts` y `cash-closure`.
4. Extraer al final los módulos con más acoplamiento: `inventory`, `sales`,
   `quotes`, `orders`, `reports` y `accounting`.
5. Convertir dependencias cruzadas en puertos públicos. Ejemplo: Pedidos no debe
   importar internals de Inventario; debe consumir una función pública como
   `inventory.reserveStock(...)` exportada desde el índice del módulo.
6. Revisar jobs y procesos asíncronos. Antes de mutar datos de una capacidad
   opcional deben leer `readCompanyModules(companyId)`; el scheduler de
   documentos comerciales ya filtra Cotizaciones y Pedidos por empresa y sirve
   como referencia.
7. Añadir pruebas por módulo para estado activo, desactivado, trial vencido,
   dependencia bloqueada, aislamiento entre empresas y permisos.

No conviene mover todos los archivos a la vez. El manifiesto permite conservar
el router legacy mientras cada extracción se valida y entrega de forma pequeña.

## Receta para otro colaborador o IA

Para migrar `<code>`:

1. Leer completo `docs/MODULE_ARCHITECTURE.md`, este archivo, el manifiesto del
   módulo y su router legacy.
2. Confirmar que código y dependencias coinciden con el registro; no inventar un
   segundo identificador.
3. Buscar referencias con `rg "controller|service|ruta" src tests`.
4. Mover un solo caso de uso manteniendo URL, payload, respuesta, permisos y
   transacción existentes.
5. Actualizar `loadRouter` para apuntar a la nueva interfaz pública solo cuando
   las pruebas del caso de uso estén verdes.
6. Ejecutar `npm run test:modules` y las pruebas del dominio afectado.
7. Verificar que `git status --short` no incluya `.env` ni `env`.

Prompt sugerido: “Migra físicamente el módulo `<code>` siguiendo
`docs/MODULE_ARCHITECTURE.md` y `docs/MODULARIZATION_HANDOFF.md`. Conserva los
contratos HTTP y Prisma, no cambies módulos vecinos, no importes internals de
otro módulo y agrega pruebas de activo/inactivo, tenant y permisos.”

## Criterio de aceptación por PR

- El router sigue entrando por el manifiesto y por `requireModule`.
- No cambian URLs ni respuestas sin una migración documentada.
- Cada consulta contiene el tenant o sucursal correspondiente.
- No hay importaciones nuevas a internals de otro módulo.
- Las transacciones de inventario, ventas y contabilidad conservan atomicidad.
- `npm run test:modules` queda verde.
- `env` permanece ignorado y fuera del commit.
