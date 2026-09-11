# Modularización de Inventario/Productos

## Objetivo

Modularizar gradualmente `inventory` siguiendo el piloto de Promociones, sin
cambiar contratos HTTP ni retirar la implementación legacy hasta comprobar su
equivalencia funcional.

## Alcance

El módulo incluye:

- Catálogo, creación, detalle, importación, baja y restauración de productos.
- Lotes y vencimientos de productos.
- Movimientos y ajustes de stock.
- Almacenes y ubicaciones.
- Las URLs frontend `/inventario`, `/productos` y `/scanner`.
- Los prefijos backend `/products`, `/stock` y `/warehouses`.

Quedan fuera `inventory-count` (Inventariado) y `merchandise` (Ingreso de
mercancía), aunque sus pantallas vivan actualmente bajo `/inventario`. Sus
prefijos más específicos conservan sus propios códigos y activaciones.

## Frontera del módulo

El código estable es `inventory`. No tiene dependencias comerciales: otros
módulos dependen de él, pero el catálogo de productos puede operar sin Ventas,
Contactos, Datos maestros, Inventariado o Mercancía activos.

La activación comercial se resuelve mediante `company_modules` y
`requireModule('inventory')`. Los permisos continúan en los routers legacy con
`Auth` y `hasPermission`. La configuración sigue siendo el objeto JSON
`company_modules.config`; esta iteración no agrega claves ni valores
predeterminados.

## Frontend

Se creará `src/modules/inventory/manifest.ts` como entrada pública de las
pantallas del módulo. Declarará:

- `code: 'inventory'` y `dependencies: []`.
- Rutas canónicas de productos, lotes y movimientos.
- `routePrefixes: ['/productos', '/scanner']` para compatibilidad legacy.
- Páginas cargadas mediante `React.lazy` desde sus ubicaciones actuales.

`App.tsx` obtendrá del manifiesto las páginas de lista, creación, detalle,
importación, eliminados, lotes y movimientos. No se moverán todavía páginas,
componentes, hooks ni servicios; los imports existentes fuera del módulo
seguirán funcionando. `config/appModules.ts` reutilizará los aliases del
manifiesto para que `ModuleAccessBoundary` mantenga el control comercial antes
de `PermissionRoute`.

## Backend

Se creará `src/modules/inventory/manifest.js`. El manifiesto declarará el
código, dependencias vacías y los tres montajes legacy:

- `/products` → `src/routes/products.routes.js`
- `/stock` → `src/routes/stock.routes.js`
- `/warehouses` → `src/routes/warehouses.routes.js`

`src/routes/index.js` montará esos routers desde el manifiesto, cada uno detrás
de `requireModule(inventoryModule.code)`. `resolveTenant` seguirá ejecutándose
antes del guard comercial; `Auth` y `hasPermission` permanecerán dentro de los
routers. Los controllers y servicios no se moverán en esta iteración.

El registro central conservará `inventory` sin dependencias. La declaración se
mantendrá sincronizada con ambos manifiestos.

## Flujo de acceso

1. El frontend consulta `/api/modules` para la empresa activa.
2. `ModuleAccessBoundary` impide abrir una URL de Inventario si `inventory` no
   está activo, incluso para administradores.
3. El backend resuelve tenant y evalúa `requireModule('inventory')`.
4. El router legacy aplica autenticación y permisos.
5. El controller ejecuta el caso de uso usando `companyId` y `branchId` como
   hasta ahora.

Un módulo en `TRIAL` con fecha vencida se considera desactivado. Si se desactiva
`inventory`, sus dependientes quedan bloqueados efectivamente sin modificar su
estado persistido.

## Inventario técnico

Frontend involucrado:

- Páginas: gestión, alta, detalle, importación, eliminados, lotes y movimientos.
- Componentes: `components/products/**`, wrapper
  `components/ProductManagement.tsx`, `components/stock/StockMovesPage.tsx` y
  `components/ScannerManagement.tsx`.
- Hooks: `useProducts`, `useProduct`, `useCreateProduct`, `useUpdateProduct`,
  `useDeleteProduct`, `useCriticalProducts` y hooks internos de formularios y
  kits.
- Servicios: `productService`, `productListService`, `stockMoveService` y
  `warehouseService`.

Backend involucrado:

- Rutas: `products.routes.js`, `stock.routes.js` y `warehouses.routes.js`.
- Controllers: `products.controller.js`, `stockMoves.controller.js` y
  `warehouses.controller.js`.
- Servicios de inventario utilizados por esos controllers: importación,
  existencias, lotes, ubicaciones, kits, precios y alertas de stock.

Este inventario describe dependencias existentes; no autoriza mover código de
otros módulos ni convertir utilidades compartidas en internals de `inventory`.

## Pruebas y validación

Las pruebas de módulos comprobarán con comportamiento observable:

- `inventory` activo explícitamente.
- `inventory` desactivado.
- trial de `inventory` vencido.
- propagación del bloqueo hacia un módulo dependiente.
- coincidencia de código, dependencias y prefijos entre manifiesto y registro.

La validación final será:

- `npm run build` en frontend.
- `npm run test:modules` en backend.
- `npx prisma validate` en backend.
- Revisión del diff para confirmar que no se modificaron archivos `.env`,
  contratos HTTP, permisos ni consultas tenant-aware.

## Entrega

Cada repositorio tendrá un commit documentado para esta iteración. No se
eliminará código legacy; una migración posterior podrá mover internals cuando
las pruebas funcionales específicas de esas capas permitan demostrar
equivalencia.
