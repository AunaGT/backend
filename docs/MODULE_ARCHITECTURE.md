# Arquitectura modular del backend

## Objetivo

Auna sigue siendo un monolito desplegable, pero cada capacidad de negocio debe
tener una frontera explícita. Un módulo activo no equivale a un permiso:

- **Activación:** la empresa contrató la capacidad.
- **Permiso:** el usuario puede ejecutar una acción dentro de esa capacidad.
- **Configuración:** parámetros propios de la empresa para esa capacidad.

El orden obligatorio de autorización es: autenticación → tenant → módulo →
permiso → caso de uso. El frontend nunca sustituye estas validaciones.

## Piezas centrales

- `src/modules/platform/registry.js`: catálogo y dependencias.
- `src/modules/platform/service.js`: estado por empresa y resolución efectiva.
- `src/modules/platform/middleware.js`: guards `requireModule` y
  `requireAnyModule`.
- `src/modules/platform/routes.js`: API de consulta y administración.
- `company_modules`: estado persistente y configuración por empresa.

La ausencia de una fila conserva el módulo activo durante la transición. Las
migraciones crean filas ACTIVE para todas las empresas existentes y el alta de
una empresa ejecuta `seedCompanyModules`. Una fila `DISABLED` o `SUSPENDED`
siempre bloquea el módulo.

## Anatomía de un módulo

```text
src/modules/<module>/
  manifest.js       # código, prefijo, dependencias e interfaz pública
  routes.js         # transporte HTTP
  application/      # casos de uso y transacciones
  domain/           # reglas puras del negocio
  infrastructure/   # Prisma, almacenamiento y proveedores externos
  tests/            # pruebas del módulo
```

Los 23 módulos registrados cargan routers y controladores desde su propia
carpeta. `npm run test:modules` comprueba que ningún manifiesto vuelva a montar
un router global. La extracción posterior de `application`, `domain` e
`infrastructure` se hace de forma incremental según
`docs/MODULARIZATION_HANDOFF.md`.

## Reglas obligatorias

1. El código del módulo es estable, ASCII, minúsculas y kebab-case.
2. Toda ruta de negocio se monta detrás de `requireModule(code)`.
3. El router aplica después `Auth` y `hasPermission`; ser administrador no
   evita la comprobación comercial del módulo.
4. Un módulo no importa controllers ni archivos internos de otro módulo.
5. La comunicación entre módulos usa una función pública de `index.js` o un
   servicio de aplicación documentado.
6. Toda dependencia se declara en el registro. No se permiten ciclos.
7. Desactivar no borra información histórica ni revierte movimientos.
8. Las migraciones permanecen centralizadas en `prisma/migrations`.
9. Los trabajos en segundo plano también deben consultar activación antes de
   procesar capacidades opcionales.
10. `config` es protegido para evitar que una empresa pierda la pantalla desde
    la que recupera su configuración.

## Añadir un módulo

1. Crear `src/modules/<code>/manifest.js`.
2. Agregar código, nombre y dependencias a `MODULE_DEFINITIONS`.
3. Agregar el mismo código al manifiesto del frontend.
4. Montar su router con `requireModule`.
5. Añadirlo al SQL de backfill si la migración aún no fue desplegada; en una
   instalación ya desplegada, crear una migración adicional.
6. Probar: activo, desactivado, prueba vencida y dependencia desactivada.
7. Documentar su configuración JSON con esquema y valores predeterminados.

## Cambiar estados

```http
GET /api/modules
PATCH /api/modules/promotions
Content-Type: application/json

{ "status": "DISABLED" }
```

Estados: `ACTIVE`, `TRIAL`, `SUSPENDED`, `DISABLED`. `TRIAL` puede acompañarse
de `trialEndsAt`. Para activar un módulo deben estar activas sus dependencias.
Al apagar una dependencia, sus dependientes quedan bloqueados de manera
efectiva sin alterar su estado propio.

## Despliegue

Orden seguro: migración de base → backend → frontend. Después verificar
`GET /api/modules` con dos empresas distintas. No desplegar el backend que usa
`companyModule` antes de aplicar la migración.

## Definición de terminado

- Guard de módulo y permisos presentes.
- Tenant usado en todas las consultas.
- Dependencias declaradas y sin ciclos.
- Pruebas de acceso activo/inactivo.
- Sin importaciones a internals de otro módulo.
- Datos históricos legibles con el módulo desactivado solo mediante procesos
  administrativos explícitos, nunca por endpoints operativos.
- Documentación y manifiesto sincronizados con frontend.
