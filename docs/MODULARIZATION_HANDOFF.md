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

## Estado de la reorganización física

Las 23 capacidades ya poseen manifiesto, router y controlador dentro de
`src/modules/<code>`. Los directorios globales `src/routes` y `src/controllers`
conservan únicamente composición o capacidades de plataforma. La prueba
`cada manifiesto carga routers físicos desde su propia carpeta` impide volver a
introducir montajes legacy.

RRHH publica validadores desde `src/modules/hr/index.js` y Cartera publica su
lógica desde `src/modules/receivables/index.js`; Nómina y Ventas consumen esas
fronteras en vez de importar internals.

La siguiente fase ya no es mover routers. Es profundizar cada dominio sin
cambiar contratos:

1. Extraer servicios globales únicamente cuando tengan un dueño claro; los
   servicios genuinamente transversales pueden permanecer en `src/services`.
2. Convertir dependencias cruzadas en índices públicos del módulo y evitar
   imports a controllers internos.
3. Revisar jobs y procesos asíncronos: antes de mutar una capacidad opcional
   deben consultar `readCompanyModules(companyId)`.
4. Añadir E2E con base de datos para activo, desactivado, trial vencido,
   aislamiento entre empresas, permisos y atomicidad.
5. Trabajar un dominio por PR aunque la frontera física común ya esté completa.

## Receta para otro colaborador o IA

Para ampliar `<code>`:

1. Leer completo `docs/MODULE_ARCHITECTURE.md`, este archivo, el manifiesto y
   el índice público del módulo si existe.
2. Confirmar que código y dependencias coinciden con el registro; no inventar un
   segundo identificador.
3. Buscar referencias con `rg "controller|service|ruta" src tests`.
4. Extraer un solo caso de uso manteniendo URL, payload, respuesta, permisos y
   transacción existentes.
5. Publicar dependencias entre módulos mediante `index.js`; nunca mediante la
   ruta física de un controller.
6. Ejecutar `npm run test:modules` y las pruebas del dominio afectado.
7. Verificar que `git status --short` no incluya `.env` ni `env`.

Prompt sugerido: “Profundiza el módulo `<code>` siguiendo
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
