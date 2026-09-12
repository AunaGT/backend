# Modularización de Ventas

## Objetivo

Modularizar gradualmente `sales` siguiendo los pilotos de Promociones e
Inventario, sin cambiar contratos HTTP ni retirar la implementación legacy
hasta comprobar equivalencia funcional.

## Alcance

El módulo incluye:

- Listado y consulta de ventas.
- Creación y cancelación de ventas.
- Visualización e impresión de factura o ticket.
- Selección, apertura y cierre operativo de sesiones de caja.
- Las URLs frontend `/ventas`, `/ventas/nueva` y
  `/ventas/:id/factura`.
- Los prefijos backend `/sales` y `/cash-sessions`.

Quedan fuera Cotizaciones (`quotes`), Pedidos (`orders`), Promociones
(`promotions`), Devoluciones (`returns`) y Cierre de caja (`cash-closure`).
Estos módulos pueden navegar hacia Ventas o depender comercialmente de ella,
pero conservan sus propios códigos, activaciones y permisos.

## Frontera del módulo

El código estable es `sales`. Su única dependencia comercial es `inventory`,
tal como está declarado en el registro central. Contactos, Promociones,
Cartera, Pedidos y Configuración participan en flujos opcionales o compartidos,
pero no son requisito para activar el núcleo de Ventas.

La activación comercial se resuelve mediante `company_modules` y
`requireModule('sales')`. Los permisos permanecen en los routers legacy con
`Auth` y `hasPermission`. La configuración sigue siendo el objeto JSON
`company_modules.config`; esta iteración no agrega claves ni valores
predeterminados.

## Frontend

Se creará `src/modules/sales/manifest.ts` como entrada pública de las pantallas
del módulo. Declarará:

- `code: 'sales'` y `dependencies: ['inventory']`.
- Las tres rutas frontend actuales.
- `routePrefixes: []`, porque Ventas no tiene aliases legacy adicionales.
- Gestión, nueva venta y factura mediante `React.lazy` desde sus ubicaciones
  actuales.

`App.tsx` obtendrá esas páginas y paths del manifiesto. No se moverán páginas,
componentes, hooks ni servicios; el wrapper
`components/SalesManagement.tsx` seguirá preservando compatibilidad.
`config/appModules.ts` reutilizará el path y los aliases del manifiesto sin
cambiar `sellerAllowed` ni los permisos existentes.

## Backend

Se creará `src/modules/sales/manifest.js` con dos montajes legacy:

- `/sales` → `src/routes/sales.routes.js`
- `/cash-sessions` → `src/routes/cashSessions.routes.js`

`src/routes/index.js` montará ambos routers desde el manifiesto, cada uno detrás
de `requireModule(salesModule.code)`. `resolveTenant` seguirá ejecutándose
antes del guard comercial; `Auth` y `hasPermission` permanecerán dentro de los
routers. Los controllers y servicios no se moverán en esta iteración.

El registro central conservará `sales` con `dependencies: ['inventory']`. Los
dos manifiestos deberán coincidir con esa definición.

## Flujo de acceso

1. El frontend consulta `/api/modules` para la empresa activa.
2. `ModuleAccessBoundary` bloquea las URLs de Ventas si `sales` no está activo,
   incluso para administradores.
3. El backend resuelve tenant y evalúa `requireModule('sales')`.
4. El router legacy aplica autenticación y permisos.
5. El controller ejecuta el caso de uso usando `companyId` y `branchId` como
   hasta ahora.

Un `TRIAL` vencido bloquea Ventas. Desactivar `inventory` bloquea Ventas por su
dependencia declarada, sin cambiar el estado persistido propio de `sales`.

## Inventario técnico

Frontend involucrado:

- Páginas: `components/sales/SalesManagement.tsx`,
  `components/sales/NewSalePage.tsx` y
  `components/sales/SaleInvoicePage.tsx`.
- Wrapper temporal: `components/SalesManagement.tsx`.
- Componentes: carrito, filtros, KPIs, tabla de estados, detalle, disponibilidad,
  autorización administrativa, promociones, cliente guardado, selector y
  apertura de caja bajo `components/sales/**`.
- Hooks: `hooks/useSales.ts`, `components/sales/hooks/useSalesData.ts`,
  `components/sales/hooks/useCart.ts` y `hooks/useRealtimeSales.ts`.
- Servicios: `saleService.ts`, `salesService.ts`, `cashSessionsService.ts` y
  `saleDraftStorage.ts`, además de servicios compartidos consumidos por el POS.
- Documentos: `generateSaleTicket.ts` y `generateSaleInvoicePDF.ts`.

Backend involucrado:

- Rutas: `sales.routes.js` y `cashSessions.routes.js`.
- Controllers: `sales.controller.js` y `cashSessions.controller.js`.
- Servicios compartidos consumidos por Ventas: resolución de precios,
  disponibilidad y kits, lotes FEFO, ubicaciones, alertas, crédito, referencias
  y búsqueda de ventas.

Existe un import legacy desde Nueva venta hacia un query key interno de Cierre
de caja. No se moverá en esta iteración porque el diseño aprobado conserva
servicios e internals; deberá resolverse cuando `cash-closure` se modularice,
publicando el contrato compartido desde `cashSessionsService`.

## Pruebas y validación

Las pruebas de módulos comprobarán:

- `sales` activo explícitamente.
- `sales` desactivado.
- trial de `sales` vencido.
- bloqueo de `sales` cuando `inventory` está desactivado.
- coincidencia de código, dependencias y prefijos entre manifiesto y registro.

La validación final será:

- `npm run build` en frontend.
- `npm run test:modules` en backend.
- `npx prisma validate` en backend.
- Revisión del diff para confirmar que no se modificaron archivos `.env`,
  contratos HTTP, permisos ni consultas tenant-aware.

## Entrega

Cada repositorio tendrá un commit documentado para Ventas. No se eliminará
código legacy ni se hará push. Una iteración posterior podrá mover internals
cuando existan pruebas funcionales suficientes para demostrar equivalencia.
