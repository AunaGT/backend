# Modularización de Contactos

## Objetivo

Modularizar gradualmente `contacts` siguiendo los pilotos de Promociones,
Inventario y Ventas, sin cambiar contratos HTTP ni retirar la implementación
legacy hasta comprobar equivalencia funcional.

## Alcance

El módulo incluye el maestro unificado actual de proveedores y clientes:

- Listado, creación, consulta, edición y eliminación de contactos.
- Importación y validación masiva de proveedores.
- Reglas de precio asociadas a clientes.
- Las URLs frontend `/contactos`, `/contactos/nuevo`,
  `/contactos/importar` y `/contactos/:id`.
- Los aliases frontend legacy bajo `/proveedores`.
- El prefijo backend legacy `/suppliers`.

Quedan fuera Cotizaciones (`quotes`), Pedidos (`orders`), Mercancía
(`merchandise`), Cartera (`receivables`) e Inventario (`inventory`). Estos
módulos consumen contactos mediante servicios existentes, pero conservan sus
propios códigos, activaciones y permisos.

## Frontera del módulo

El código estable es `contacts` y no tiene dependencias comerciales. Otros
módulos pueden depender de Contactos, pero desactivar uno de ellos no debe
bloquear el maestro de contactos.

La activación comercial se resuelve mediante `company_modules` y
`requireModule('contacts')`. Los permisos separados de proveedores y clientes
permanecen en el router y controller legacy mediante `Auth`, `hasPermission` y
las comprobaciones por `party_type`. La configuración continúa en
`company_modules.config`; esta iteración no agrega claves ni valores
predeterminados.

## Frontend

Se creará `src/modules/contacts/manifest.ts` como entrada pública de las
pantallas del módulo. Declarará:

- `code: 'contacts'` y `dependencies: []`.
- Los cuatro paths actuales bajo `/contactos`.
- `routePrefixes: ['/proveedores']` para proteger las redirecciones legacy.
- Gestión, creación, importación y detalle mediante `React.lazy` desde sus
  ubicaciones actuales.

`App.tsx` obtendrá páginas y paths del manifiesto. Las redirecciones legacy se
mantendrán, incluido el redirect dinámico por identificador. No se moverán
páginas, componentes, hooks ni servicios. `config/appModules.ts` reutilizará
el path y los aliases del manifiesto sin cambiar permisos ni visibilidad por
rol.

## Backend

Se creará `src/modules/contacts/manifest.js` con un montaje legacy:

- `/suppliers` → `src/routes/suppliers.routes.js`

`src/routes/index.js` montará ese router desde el manifiesto detrás de
`requireModule(contactsModule.code)`. `resolveTenant` seguirá ejecutándose
antes del guard comercial; `Auth`, `hasPermission` y las comprobaciones de
tipo de contacto permanecerán dentro del código legacy. Controller, servicios
y utilidades no se moverán en esta iteración.

El registro central conservará `contacts` con `dependencies: []`. Los dos
manifiestos deberán coincidir con esa definición.

## Flujo de acceso

1. El frontend consulta `/api/modules` para la empresa activa.
2. `ModuleAccessBoundary` bloquea `/contactos` y `/proveedores` si `contacts`
   no está activo, incluso para administradores.
3. El backend resuelve tenant y evalúa `requireModule('contacts')` para
   `/suppliers`.
4. El router legacy autentica y aplica los permisos existentes.
5. El controller conserva el filtrado tenant-aware y distingue proveedores de
   clientes por `party_type`.

Un `TRIAL` vencido bloquea Contactos. Desactivar `inventory` u otro módulo no
lo bloquea porque `contacts` no declara dependencias.

## Inventario técnico

Frontend involucrado:

- Páginas: `components/SuppliersManagement.tsx`,
  `components/suppliers/SupplierCreatePage.tsx`,
  `pages/SupplierImportPage.tsx` y
  `components/suppliers/SupplierDetailPage.tsx`.
- Componentes auxiliares: `components/suppliers/SupplierImportDialog.tsx` y
  `components/suppliers/generateSupplierPDF.ts`.
- Hooks: `hooks/useSuppliers.ts`, `hooks/useSupplier.ts`,
  `hooks/useCreateSupplier.ts`, `hooks/useUpdateSupplier.ts` y
  `hooks/useDeleteSupplier.ts`.
- Servicio y tipos: `services/supplierService.ts`, `types/supplier.ts` y los
  tipos compartidos reexportados desde `types`.

Backend involucrado:

- Ruta: `routes/suppliers.routes.js`.
- Controller: `controllers/suppliers.controller.js`.
- Servicio: `services/supplierBulkImport.js`.
- Utilidad de autorización por tipo:
  `utils/contactsPermissions.js`.

Los consumidores externos actuales de `supplierService` y del modelo de
contactos seguirán usando sus ubicaciones legacy. Moverlos ahora convertiría
internals de Contactos en dependencias directas de módulos aún no migrados.

## Pruebas y validación

Las pruebas de módulos comprobarán:

- `contacts` activo explícitamente.
- `contacts` desactivado.
- trial de `contacts` vencido.
- independencia de `contacts` cuando `inventory` está desactivado.
- coincidencia de código, dependencias y prefijo entre manifiesto y registro.

La validación final será:

- `npm run build` en frontend.
- `npm run test:modules` en backend.
- `npx prisma validate` en backend.
- Revisión del diff para confirmar que no se modificaron archivos `.env`,
  contratos HTTP, permisos, filtros por tenant ni código legacy fuera del
  ensamblaje modular.

## Entrega

Cada repositorio tendrá un commit documentado para Contactos. No se eliminará
código legacy ni se hará push. Una iteración posterior podrá mover internals
cuando sus consumidores tengan contratos públicos y pruebas funcionales
suficientes.
