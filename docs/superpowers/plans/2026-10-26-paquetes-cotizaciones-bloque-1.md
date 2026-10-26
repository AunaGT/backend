# Paquetes cotizables — Bloque 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Crear paquetes comerciales versionados, acordar productos y cantidades durante la cotización y conservar esa composición y su precio hasta pedido, contratación, venta y devolución.

**Architecture:** Los paquetes agrupan partidas reales, sin crear un cuarto tipo de producto ni un encabezado contabilizable. Un calculador de servidor comparte validación y expansión entre catálogo, cotización y conversiones; los documentos conservan una copia congelada y claves de componente que impiden mezclar partidas de grupos diferentes. Inventario, Agenda, contabilidad y devoluciones siguen usando sus mecanismos actuales.

**Tech Stack:** Node.js/CommonJS, Express, Prisma/PostgreSQL, decimales exactos de `src/services/units/quantity.js`, React/TypeScript, React Query y componentes de interfaz existentes. No añadir dependencias.

**Spec:** `/home/DiegoPatzan/Documents/CODE/Auna/deposito-backend/docs/superpowers/specs/2026-10-26-paquetes-productos-servicios-design.md` — aprobado por el usuario.

## Global Constraints

- La distribución de productos y cantidades, incluidos los sabores de un paquete, **se acuerda durante la cotización**.
- La definición del paquete es un catálogo versionado; una cotización conserva una copia validada de la versión elegida.
- Modificar el catálogo no cambia lo ya cotizado, aceptado, vendido o programado.
- La cotización no consume stock.
- Los equipos y profesionales no son componentes consumibles ni una cantidad de stock del paquete.
- Aceptar la cotización fija el acuerdo comercial; **no equivale a reservar personal o equipo ni a recibir un pago**.
- Las API keys no adquieren permisos automáticamente ni pueden fijar precios libres.
- No se autorizaron emisiones, conexiones ni pruebas con Infile.
- No ejecutar migraciones sobre la base activa: probarlas en una base temporal y solicitar aplicación posteriormente.
- Preservar los cambios existentes en ambos repositorios; no resetear, reconstruir ni cargar datos reales.
- Este plan entrega solamente el bloque 1. Los requisitos operativos avanzados y las nuevas capacidades de integración no se considerarán entregados aquí.

## Review Focus

1. Un borrador con selección incompleta debe poder reabrirse sin parecer una propuesta de precio cero lista para aceptar; cubrir en Task 3 y Task 6.
2. Dos paquetes pueden contener el mismo producto, incluso en presentaciones distintas, sin fusionar cantidades o perder su precio de origen; cubrir en Task 1, Task 4 y Task 6.
3. Una entrega o devolución de fracciones consecutivas debe conservar exactamente el importe original, incluso cuando la última fracción absorbe un centavo; cubrir en Task 4.
4. Cambiar de empresa/sucursal mientras llega una respuesta de catálogo o precio no debe insertar datos en el nuevo formulario; cubrir en Task 5 y Task 6.
5. Un cliente antiguo o una API key no puede borrar la composición al reemplazar partidas, ni una plantilla pública puede obtener ponderaciones o costos privados; cubrir en Task 3 y Task 7.

---

## Alcance por bloque y mapa de archivos

Raíces: **B** = `/home/DiegoPatzan/Documents/CODE/Auna/deposito-backend`; **F** = `/home/DiegoPatzan/Documents/CODE/Auna/deposito-frontend`. Los paths de cada tarea son relativos a esa raíz explícita.

Bloque 1 incluye definición interna de paquetes, variantes y elecciones; selección completa o incompleta en borradores; precio cerrado asignado una sola vez; conservación en todos los destinos actuales; edición de composición solamente desde su acuerdo de origen; representación interna, compartida y PDF.

Bloque 2 tendrá otro plan para requisitos de profesionales/equipos, hitos de intervención, zonas de traslado y condiciones de anticipo/vencimiento. Bloque 3 tendrá otro plan para catálogo externo de paquetes, selección por API y disponibilidad horaria pública acotada. El bloque 1 no agrega formularios simulados para esas capacidades ni modifica su semántica actual.

| Unidad | Archivos principales nuevos | Responsabilidad |
| --- | --- | --- |
| Dominio | `B/src/modules/inventory/packages/definition.js`, `selection.js`, `pricing.js` | Validar contratos cerrados y calcular composición/precio exactos. |
| Catálogo | `B/src/modules/inventory/packages/catalog.js`, `routes.js`, `controller.js` | Versiones inmutables, permisos y sucursales; sin CRUD de productos nuevos. |
| Acuerdo | `B/src/services/commercialPackages.js` | Expandir selecciones de servidor, verificar acuerdos congelados y proyectar datos públicos. |
| Persistencia | `B/prisma/schema.prisma`, una migración aditiva nueva | Catálogo versionado, copias por documento y claves de componentes. |
| Pantallas | `F/src/modules/inventory/packages/` | Lista y página de edición de paquetes con componentes existentes. |
| Cotización | `F/src/modules/quotes/QuoteEditor.tsx`, `EditQuotePage.tsx`, `components/QuotePackagesEditor.tsx` | Crear/reabrir el mismo acuerdo sin inventar selecciones ni recalcular las ya guardadas. |
| Presentación | `F/src/components/shared/CommercialPackageSummary.tsx` | Mostrar grupo y desglose sin cobrar otra línea. |

Los demás archivos exactos aparecen en su tarea, incluidos los consumidores de conversiones. No cambiar todo `Product` ni refactorizar módulos ajenos.

## Contratos que comparten las tareas

### Definición de catálogo

`PackageDefinition = {schemaVersion:1, name, description, imageUrl, currency, variants}`.

Cada variante tiene `{id, name, price, components, choices}`. Un componente fijo tiene `{id, productId, quantity, presentationId, unitRevision, weight}`. Un grupo de elección tiene `{id, name, totalQuantity, maxDistinct, weight, options}`; cada opción contiene `{id, productId, presentationId, unitRevision}`. IDs internos de variante/componente/grupo/opción son UUID estables y distintos dentro de su ámbito. Los artículos de diferentes variantes pueden referir el mismo producto sin duplicar productos.

Usar cadenas decimales canónicas. Límites: nombre 150, descripción 2.000; hasta 20 variantes; hasta 50 componentes fijos, 10 grupos y 50 opciones por grupo; máximo 100 partidas reales resultantes entre paquetes y artículos sueltos del documento. JSON de definición y de acuerdo: hasta 256 KiB cada uno, además del límite HTTP existente. Peso entre `0` y `1000000`, hasta cuatro decimales; precio entre `0` y `9999999999.99`, exactamente dos decimales monetarios. La suma global del documento también debe respetar su almacenamiento actual. No truncar silenciosamente.

Cada grupo de elección admite solo opciones con la misma unidad comercial, precisión y factor de presentación; se comparan por definición de unidad, no solo por el texto de su etiqueta. Sus cantidades se acuerdan en esa unidad. La cantidad total es positiva y respeta su precisión. Componentes y opciones se resuelven en la empresa/sucursal autorizada; un SERVICE exige servicios habilitados. No aceptar refs a profesionales/equipos como `productId`.

El servidor determina moneda, productos y conversiones reales. `imageUrl` usa el mecanismo/validador de imágenes existente: no URL firmada, credencial, HTML ni descarga desde servidor. Si no hay una utilidad reutilizable, admitir únicamente URL HTTPS de medios existentes validada con `URL`, sin usuario, contraseña, query ni fragmento; no introducir un uploader nuevo.

### Selección comercial

`PackageSelection = {groupId, packageId, version, variantId, choices}`; `choices` es un array de `{choiceId, items:[{optionId, quantity}]}`. No recibe nombres, precio, costo, ponderaciones, estado, snapshot ni cantidades convertidas. Un grupo representa una unidad comercial del paquete; para dos unidades se agregan dos grupos, que pueden tener selecciones distintas. `groupId` es UUID, únicamente identidad local, nunca autorización ni referencia a otro documento.

El cliente envía `packages: PackageSelection[]` junto con `items` de artículos sueltos. No envía las partidas expandidas como si fueran artículos libres. El servidor produce `packageGroups` y partidas con `package_component_key`; esta clave tiene la forma `groupId:leafId` y nunca se usa para consultar datos sin scope de propietario.

`PackageGroupSnapshot = {schemaVersion:1, groupId, packageId, version, variantId, name, variantName, currency, state, estimatedAmount, amount, netAmount, selection, components, issues}`. `state` es `INCOMPLETE|COMPLETE`. Cada componente conserva clave, IDs de producto/presentación, unidad/revisión y snapshot, cantidad, nombre, tipo, precio, `lineTotal` y `netLineTotal` exactos. `amount` es el precio del grupo antes del descuento global del documento; `netAmount` es su parte efectiva después de ese descuento. Las ponderaciones viven solamente en la versión privada de catálogo; no entran en este objeto público de acuerdo. Los costos viven únicamente donde ya corresponden en los módulos actuales.

Un grupo incompleto no genera partidas ni importe contabilizable: `amount:null` y `netAmount:null`; `estimatedAmount` conserva el precio orientativo de su variante. El total del borrador suma únicamente partidas completas/sueltas. La interfaz debe mostrar «Total pendiente de completar», el estimado y la lista de faltantes, no presentar ese subtotal como precio final. Se admite un borrador con solo grupos incompletos y cero partidas; se prohíbe cerrar, compartir como propuesta final o convertirlo.

Los descuentos globales autorizados se reparten sobre todas las partidas reales,
incluidas las libres, en su orden guardado, con el mecanismo acumulado exacto
existente. De allí se derivan `netLineTotal` y `netAmount`. No se vuelve a aplicar
ese descuento al convertir ni al devolver. Las vistas distinguen precio original
y neto; una venta parcial conserva el acuerdo completo como referencia pero
factura únicamente sus componentes y asignaciones netas consumidas.

### Copia y conservación

Añadir `package_groups Json?` a `CommercialDocument`, `Sale` y `AppointmentEngagement`; añadir `package_component_key String? @db.VarChar(73)` a `CommercialDocumentLine`, `SaleItem` y `AppointmentEngagementLine`. No exigir campos en filas antiguas ni inventar snapshots históricos.

Los consumidores mapean explícitamente el JSON a `packageGroups` en sus DTO internos. Cada partida conserva la clave en su campo existente de estilo snake_case. Los DTO públicos usan una proyección explícita: nombre, variante, estado completo, cantidades, nombres/unidades de componentes y monto comercial; no selección técnica, costos, pesos, ni datos privados de Agenda.

La propiedad del grupo reside en el documento y sucursal, no en los UUID aportados. En conversiones conservar grupo/clave y origen, pero nunca resolver una definición del catálogo actual para reconstruir el acuerdo. La versión de catálogo usada permanece inmutable y se conserva aun si se archiva el paquete.

## Task 1: Contratos cerrados y reparto exacto del precio

**Files:**
- Create: `B/src/modules/inventory/packages/definition.js`, `selection.js`, `pricing.js`.
- Create: `B/tests/packages.definition.test.js`, `packages.selection.test.js`, `packages.pricing.test.js`.
- Reuse: `B/src/services/units/quantity.js`, `B/src/services/units/commercial.js`.

**Interfaces:**
- `parsePackageDefinition(raw, {complete}) -> PackageDefinition` normalizada; rechaza claves desconocidas, objetos heredados, tipos no planos y límites excedidos.
- `parsePackageSelections(raw) -> PackageSelection[]` sin acceder a DB.
- `validatePackageSelection(definition, selection) -> {state, issues, leaves}`. Cada leaf tiene clave de origen, referencia a artículo, cantidad y peso de asignación.
- `allocatePackagePrice({amount, leaves}) -> Array<{key, unitPrice, lineTotal}>`; cantidades/precios importes son cadenas exactas.

- [x] **Step 1 — Escribir pruebas rojas.** `rejects_untrusted_definition_fields` debe rechazar `cost`, `script`, `__proto__`, pesos negativos, infinito, `1e3` y límites excedidos. `agreement_is_completed_during_quote` debe aceptar total 160 con opciones de 80+80 si `maxDistinct:2`, y devolver INCOMPLETE para 80 de 160; rechazar 161, duplicados y una tercera opción. `same_product_in_two_groups_keeps_two_keys` debe producir dos claves y partidas, no una suma sin origen.
- [x] **Step 2 — Verificar rojo.** Ejecutar en B `node --require ./tests/setup-env.js --test tests/packages.definition.test.js tests/packages.selection.test.js tests/packages.pricing.test.js`; esperar fallo por módulos nuevos ausentes, no por credenciales.
- [x] **Step 3 — Implementar las interfaces.** La selección incompleta no es un error estructural; exceso, opción ajena o unidad incompatible sí lo son. Para el reparto usar proporciones acumuladas en orden estable por ID, redondeadas a centavos, asignando la diferencia entre acumulados a cada hoja. Primero se asigna por peso de componente/grupo, luego dentro del grupo por cantidad. El último acumulado equivale al precio total; no usar `Number`, costos o precios actuales como ponderación. Derivar precio unitario con hasta 18 decimales y verificar que `lineTotal(qty, unitPrice)` reproduzca el importe asignado; si no, `PACKAGE_PRICE_REVIEW_REQUIRED`.
- [x] **Step 4 — Agregar y pasar pruebas de dinero.** `residual_cent_is_stable` asigna `0.05` a tres hojas de igual peso como `0.02,0.01,0.02` en el orden fijado. `free_component_is_not_revenue` conserva un peso cero y precio cero. `mixed_decimal_quantities_sum_exactly` verifica suma exacta de importes, representación de precios y rechazo de montos fuera de almacenamiento. Comparar 160 unidades con el mismo total distribuido en dos sabores. Ejecutar las tres pruebas: todas PASS.
- [x] **Step 5 — Checkpoint.** Revisar diff y guardar solo los archivos propios de esta tarea; nunca incluir cambios preexistentes en un commit/checkpoint.

## Task 2: Catálogo versionado, permisos y migración aditiva

**Files:**
- Modify: `B/prisma/schema.prisma`, `B/src/modules/inventory/manifest.js`.
- Create: `B/prisma/migrations/20261026120000_commercial_packages/migration.sql`.
- Create: `B/src/modules/inventory/packages/catalog.js`, `controller.js`, `routes.js`.
- Create: `B/tests/packages.catalog.test.js`, `packages.permissions.test.js`, `packages.migration.pg.e2e.js`.
- Create: `B/tests/helpers/packagesDb.js`.

**Interfaces:**
- `listPackages(db, scope, query)`, `getPackage(db, scope, id)`.
- `savePackage(db, scope, idOrNull, {expectedVersion, definition, branchIds, idempotencyKey})` guarda borrador de definición y aumenta su versión de edición.
- `activatePackageVersion(db, scope, id, {expectedVersion, idempotencyKey})` valida definición completa y referencias, crea versión inmutable, actualiza el puntero activo.
- `archivePackage(db, scope, id, {expectedVersion, idempotencyKey})` desactiva nuevas selecciones sin borrar versiones ni acuerdos.
- `loadPackageVersion(tx, scope, packageId, version, {forNewSelection})` devuelve definición privada autorizada y productos resueltos; para historia no exige que siga siendo la versión activa.

- [x] **Step 1 — Escribir pruebas rojas de catálogo.** `foreign_product_or_branch_is_not_resolved` devuelve 404 sin describir la empresa ajena. `shared_package_requires_all_assigned_branches` replica la protección del perfil compartido de Agenda. `version_is_immutable_and_archive_preserves_agreement` publica v1, guarda v2 y comprueba que v1 no cambia. `stale_write_and_repeat_activation` exige conflicto en revisión vieja y una sola versión ante dos reintentos equivalentes.
- [x] **Step 2 — Verificar rojo.** En B: `node --require ./tests/setup-env.js --test tests/packages.catalog.test.js tests/packages.permissions.test.js`.
- [x] **Step 3 — Implementar esquema y catálogo.** Modelos `CommercialPackage` (empresa, nombre, borrador de definición, versión de edición, active_version, archived_at, creador y fechas), `CommercialPackageVersion` (empresa, paquete, número, definition, content_hash, request_key, created_by/at) y `CommercialPackageBranch` (empresa, paquete y sucursal). FK compuestas por empresa; unicidad `(company_id,package_id,version)` y `(company_id,package_id,request_key)`; índice de lista `(company_id,archived_at,id)` y de sucursal. Activar RLS en las tablas nuevas sin policies de acceso anónimo; el acceso sigue siendo por backend con scope. Publicar dentro de transacción con bloqueo del paquete y comprobación de referencias de productos en orden estable. Proteger UPDATE/DELETE de versiones publicadas mediante trigger invocador sin SQL dinámico. Guardar borrador estructuralmente válido aunque falten campos de activación. No guardar cuerpo recibido sin normalizar.
- [x] **Step 3b — Reintentos del catálogo.** Añadir `CommercialPackageCommand` (empresa, actor, acción, request_key, input_hash, package_id, receipt JSON acotado a 16 KiB, fechas; FK de empresa/paquete y unicidad `(company_id,actor_id,action,request_key)`, RLS sin acceso anónimo). Save/activate/archive usan bloqueo advisory de esa identidad, comparan hash canónico y guardan el recibo con ID/revisión del resultado en la misma transacción. Repetir la misma solicitud devuelve ese recibo; misma key con otro contenido devuelve 409. No utilizar tablas de integración o Agenda para operaciones de Inventario. La prueba `lost_create_response_does_not_create_two_packages` verifica un solo paquete; `old_save_retry_does_not_overwrite_new_revision` devuelve recibo previo sin reescribir el borrador actual.
- [x] **Step 4 — Agregar rutas internas.** Montar `/commercial-packages` desde el manifiesto de Inventario. GET list/detail requiere `products.view`; POST/PUT/activate/archive requiere `products.edit` y acceso a todas las sucursales compartidas. Rutas: GET `/`, GET `/:id`, POST `/`, PUT `/:id`, POST `/:id/activate`, POST `/:id/archive`. Scope de Auth/tenant, Inventario habilitado; servicios habilitados únicamente si la composición los usa. Lista paginada hasta 100, filtro de sucursal autorizado. Reutilizar permisos, no crear roles con privilegios implícitos.
- [x] **Step 5 — Agregar campos de copia del contrato.** JSON opcional acotado por CHECK de tipo/tamaño y schemaVersion en los tres encabezados; claves opcionales de componente en las tres tablas de partidas. Índices de clave dentro de propietario para consultas de procedencia, no unicidad en `SaleItem` porque varias facturaciones parciales pueden conservar el mismo origen. Los encabezados/partidas antiguos permanecen NULL. No modificar migraciones ya aplicadas ni funciones de reservas existentes.
- [x] **Step 6 — Verificar en PostgreSQL desechable.** Crear una prueba opt-in cuyo único origen de conexión sea `PACKAGES_TEST_DATABASE_URL`; rechazar si no es loopback, no tiene nombre `auna_packages_test_...` o coincide con variables de la app. El runner no carga `.env` ni hace fallback. Crear base sintética con migraciones previas, tomar copias de claves/recibos/documentos de fixture, aplicar solamente la nueva migración y verificar que permanecen iguales. Intentar versión mutable y FK cruzada: deben fallar. Verificar NULL en documentos antiguos, revisión rotada al modificar grupos/clave de una partida, rollback atómico y guardas de reservas antiguas intactos. Prueba manual SQL no sustituye esta prueba automatizada.
- [x] **Step 7 — Verificar verde y esquema.** Unit tests PASS; `prisma validate` con valores sintéticos si exige URLs, sin conexión. PostgreSQL aislado PASS antes de pedir aplicar nada en localhost. Actualizar cliente Prisma del entorno de prueba según el procedimiento existente, sin regenerar ni migrar una instancia activa por sorpresa. Checkpoint de archivos propios.

## Task 3: Acuerdo de paquete dentro de cotizaciones y controles de cierre

**Files:**
- Create: `B/src/services/commercialPackages.js`.
- Modify: `B/src/modules/quotes/controller.js`, `routes.js`, `index.js`.
- Modify: `B/src/services/commercialDocumentConcurrency.js` solo si hace falta exponer la revisión actual en el DTO; reutilizar los bloqueos existentes.
- Modify: `B/src/modules/integrations/draftDocument.js`.
- Create: `B/tests/packages.quotes.test.js`, `packages.transitions.test.js`, `packages.api-guard.test.js`.

**Interfaces:**
- `buildPackageGroups(tx, scope, selections, {existingGroups, allowIncomplete}) -> {groups, lines, subtotal, issues}`. Toma precios de la versión autorizada, resuelve unidades actuales para selección nueva, conserva snapshots para una selección que no cambió.
- `finalizePackageAmounts(groups, lines, {documentTotal}) -> groups` deriva importes netos con `cumulativeAmount` sobre todas las partidas, sin modificar los precios originales.
- `assertPackageAgreement(document, {requireComplete, kind:'DOCUMENT'|'SALE', allowPartial:false|true}) -> void`. En documentos completos verifica correspondencia exacta de claves, productos, unidades, cantidades e importes entre grupos y partidas, no solo el total del encabezado. En venta parcial valida el subconjunto contra cantidades e importes netos de origen; los contadores/bloqueos existentes verifican el consumo acumulado entre ventas.
- `packageLineFields(line) -> {package_component_key}` o `{}`; usar únicamente sobre filas/cálculos internos confiables.
- `publicPackageGroups(groups) -> PublicPackageGroup[]` por allowlist.
- POST `/quotes/package-preview` recibe `{packages}` con sucursal del scope y responde `{packageGroups, items, subtotal, issues}` sin costos. Permiso `quotes.create` + `products.view`.

- [x] **Step 1 — Escribir pruebas rojas de borrador y cierre.** `incomplete_draft_round_trips_without_stock` permite una selección parcial, conserva faltantes y no reserva/consume. `cannot_send_share_accept_or_convert_incomplete` prueba envío, generación de enlace, respuesta pública de aceptación y los destinos de conversión. `source_component_cannot_be_overridden` rechaza incluir claves/snapshot/precios de paquete dentro de `items` libres. `old_client_cannot_remove_groups` actualiza con un payload viejo de partidas y verifica conflicto, no pérdida del grupo.
- [x] **Step 2 — Verificar rojo.** En B: `node --require ./tests/setup-env.js --test tests/packages.quotes.test.js tests/packages.transitions.test.js tests/packages.api-guard.test.js`.
- [x] **Step 3 — Implementar construcción del acuerdo.** En creación/edición, `items` contiene solamente artículos libres; `packages` distingue omisión (conservar acuerdos) de `[]` (quitar grupos de un borrador explícitamente). Para documentos con paquetes, toda sustitución de composición requiere `expectedRevision` igual a `integration_revision`, bloquear documento y respetar reservas/vinculaciones actuales; falta de revisión devuelve 428, conflicto devuelve 409. Si un cliente omite `packages` y reemplaza `items` de un documento que ya contiene grupos, devolver `PACKAGE_REVIEW_REQUIRED`, no interpretar sus líneas como libres. Para crear un documento de solo grupos incompletos, permitir cero partidas reales únicamente en DRAFT. Después de resolver artículos libres, descuentos autorizados y componentes, llamar `finalizePackageAmounts` para conservar también las asignaciones netas. Guardar estado/grupos/partidas/total atómicamente. Eliminar los grupos de un borrador no elimina reservas de otro documento ni evita las restricciones sobre fuentes vinculadas.
- [x] **Step 4 — Conservar acuerdos al cambiar catálogo.** Una selección nueva usa versión activa; guardar una selección ya existente con los mismos IDs/opciones/cantidades conserva su precio, incluso si se publica v2. Modificarla exige elegir explícitamente la versión aplicable; si el producto o unidad ya no permiten la operación devolver un error accionable, no sustituir producto/precio. Releer y validar antes de cerrar.
- [x] **Step 5 — Guardas en todos los puntos de entrada.** Invocar `assertPackageAgreement(...,{requireComplete:true,kind:'DOCUMENT',allowPartial:false})` antes de enviar, obtener enlace compartido, aceptar desde UI o token público, convertir a pedido/venta y cargar fuente para Agenda. Activar el guard también en rutas de venta/confirmación de Task 4 con `kind:'SALE'` y el modo parcial correspondiente. Hasta bloque 3, `assertMutableDraft` de integración devuelve `DOCUMENT_REVIEW_REQUIRED` para documentos con grupos: una key no puede reemplazar/cancelar la composición añadida internamente sin revisión. Los contratos de entrada API siguen rechazando `packages` y snapshots.
- [x] **Step 6 — Verificar regresiones.** Las nuevas pruebas y `tests/quotes.module.test.js`, `tests/quotes.service-conditions.test.js`, `tests/commercialDocumentConcurrency.test.js`, `tests/integrations.mutations.test.js` e `integrations.mutation-http.test.js` pasan. Documentos sin paquetes conservan entrada, estados y comportamiento previo. Checkpoint propio.

## Task 4: Procedencia en pedido, Agenda, venta, parcialidades y devoluciones

**Files:**
- Modify: `B/src/modules/quotes/saleDraft.js`, `B/src/modules/orders/controller.js`.
- Modify: `B/src/modules/appointments/engagementRecords.js`, `sourceVerification.js`, `commercialQueries.js`.
- Modify: `B/src/modules/sales/engagementSale.js`, `manualSales.js`, `application.js`.
- Modify: `B/src/services/units/saleLines.js`, `commercial.js`, `B/src/services/commercialDocumentFulfillment.js`.
- Modify: `B/src/modules/returns/application.js`, `presentation.js` únicamente donde se proyecta la procedencia del artículo vendido.
- Create: `B/tests/packages.conversions.test.js`, `packages.partials.test.js`, `packages.stock.test.js`, `packages.concurrent.pg.e2e.js`.

**Interfaces:**
- Usar `assertPackageAgreement`, `packageLineFields` y las copias de Task 3. `loadQuoteSource` agrega `packageGroups` a su fuente confiable; `createEngagementRecord` conserva encabezado y claves.
- `copyPackageGroups(groups) -> validated copy` dentro de `commercialPackages.js`; no consulta catálogo.
- `packageSourceFingerprint(groups, lines) -> sha256` de contrato canónico para detectar cambios de composición aunque no cambie el importe.

- [x] **Step 1 — Escribir pruebas rojas de destinos.** `quote_order_engagement_sale_preserve_groups` crea un producto físico y un servicio en un grupo, cambia catálogo y verifica selección/precio original en cada destino admitido. `same_product_different_groups_never_merge` exige que las partidas mantengan su clave. `tampered_same_total_is_not_same_agreement` cambia sabor/unidad sin cambiar total y exige `SOURCE_REVIEW_REQUIRED`.
- [x] **Step 2 — Escribir pruebas rojas de parciales.** `fractional_deliveries_and_invoices_finish_exactly` usa precio total `19.99`, cantidades `0.5` + `0.5`: se asignan `10.00` y `9.99` sin cobrar encabezado; entrega y factura no descuentan dos veces. `partial_return_uses_sold_net_total` devuelve fracciones con importes de venta originales, no precio actual. `group_discount_is_applied_once` cotiza un grupo de `100.00` y artículo suelto de `100.00`, total con descuento global `180.00`: cada parte neta es `90.00`; convertir, facturar y devolver no vuelven a descontar. `legacy_reservations_and_package_retry_do_not_duplicate_stock` conserva el dueño real de reserva aun con FK antiguas y reintento simultáneo.
- [x] **Step 3 — Verificar rojo.** En B: `node --require ./tests/setup-env.js --test tests/packages.conversions.test.js tests/packages.partials.test.js tests/packages.stock.test.js`.
- [x] **Step 4 — Propagar únicamente datos confiables.** Guardar JSON/claves al crear pedido, fuente de Agenda, líneas de contratación y venta. `insertSaleRecord` conserva la clave en `SaleItem`, sin otra partida de encabezado ni otro ingreso. El resolver de unidades conserva clave solamente cuando trabaja con filas aprobadas/servidor; las entradas libres de usuario no pueden aportar ese campo ni `approved:true`. La comparación de fuente incluye huella del grupo. Bloquear edición manual de ventas derivadas según el mecanismo actual de propiedad del acuerdo.
- [x] **Step 5 — Reutilizar cálculo parcial existente.** Usar `cumulativeAmount` y totales netos congelados para fracciones, base/presentación original, descuentos globales y residuos; no introducir aritmética financiera paralela. Copias en venta mantienen snapshot del grupo original y permiten identificar qué cantidad/importe de sus componentes se factura aquí; su suma facturada no puede exceder la asignación neta acordada. Cancelaciones conservan el acuerdo histórico y liberan únicamente sus propias reservas. Una devolución sigue referenciando el `SaleItem` original; no necesita duplicar el catálogo en otra tabla.
- [x] **Step 6 — Probar stock y fabricación.** Fabricar un producto desde ingredientes; vender sus unidades terminadas dentro del paquete y verificar que se consume una sola vez el terminado, sin volver a consumir materias primas. Un SERVICE o un recurso no crea movimiento físico. Un KIT existente dentro de un paquete utiliza su mecanismo físico actual una sola vez. No crear recetas nuevas ni equipo inventariado como parte de la prueba.
- [x] **Step 7 — PostgreSQL aislado y regresiones.** Reutilizar únicamente la base sintética permitida de Task 2. Dos conversiones/confirmaciones simultáneas producen un destino y un consumo; edición y aceptación concurrentes no aceptan una composición vieja. Ejecutar además `tests/quotes.sale-draft.test.js`, `appointments.engagements.test.js`, `appointments.commercial-sale.test.js`, `orders.fulfillment.test.js`, `units.commercial.test.js`, `units.returns.test.js`, `own-receipts.test.js`, `units.kits.test.js`. Todo PASS antes del checkpoint propio.

## Task 5: Catálogo de paquetes en Inventario

**Files:**
- Create: `F/src/modules/inventory/packages/types.ts`, `api.ts`, `PackageListPage.tsx`, `PackageEditorPage.tsx`, `PackageVariantFields.tsx`.
- Modify: `F/src/modules/inventory/manifest.ts`, `products/ProductManagement.tsx`, `F/src/App.tsx`, `F/src/components/layout/pageTrail.ts`.
- Create: `F/tests/packages.catalog-ui.test.cjs`, `packages.navigation.test.cjs`.

**Interfaces:**
- API tipada: `fetchPackages`, `fetchPackage`, `savePackage`, `activatePackage`, `archivePackage`; usar `apiFetch`, AbortSignal y scope explícito de empresa/sucursal.
- Rutas `/inventario/paquetes`, `/inventario/paquetes/nuevo`, `/inventario/paquetes/:id/editar`; deben declararse antes de `/inventario/:id`.
- `PackageVariantFields` edita la definición tipada de Task 1; consulta productos existentes, no crea duplicados.

- [x] **Step 1 — Pruebas rojas de navegación y edición.** `package_routes_do_not_match_product_detail` verifica resolución de rutas y breadcrumbs. `editor_reuses_system_controls` exige Input/Select/Button, avisos y empty state del sistema, labels y errores vinculados; no inputs gigantes de estilo independiente. `tenant_switch_discards_late_package_response` cambia scope antes de una respuesta y exige no insertar sus datos.
- [x] **Step 2 — Verificar rojo.** En F: `node --test tests/packages.catalog-ui.test.cjs tests/packages.navigation.test.cjs` usando los harness existentes de TS/React; sin abrir una sesión productiva.
- [x] **Step 3 — Implementar páginas.** Lista paginada con estado Borrador/Activo/Archivado, buscador y acción «Nuevo paquete» según `products.edit`; estado vacío ilustrado existente. En editor de página completa conservar sidebar, barra compacta, nombre/descripción, sucursales y variantes con expansión progresiva. Cada variante muestra precio, productos/servicios fijos, grupos de elección, unidad, total y límite de opciones. La distribución del precio usa porcentajes/pesos de venta explicados como «Distribución del precio», nunca costos. Se muestra importe calculado por sección antes de activar; errores de server junto al campo.
- [x] **Step 4 — Estados y concurrencia.** Guardar borrador sin activar; activar solo versión válida; advertir cambios sin guardar; conflicto exige recargar/comparar antes de sobrescribir. Archivar usa confirmación del sistema y explica que no modifica cotizaciones existentes. Invalidar queries de la empresa afectada, no limpiar caché global. Anular peticiones al cambiar scope y usar keys con company/branch.
- [x] **Step 5 — Verificar verde.** Nuevas pruebas PASS; checks de módulos existentes, navegación y build de F PASS. Revisión visual posterior con skill de UI/UX y browser apropiado: escritorio, ancho reducido y teclado; no elegir otra librería ni un modal de edición. Checkpoint solo archivos propios.

## Task 6: Cotizar y reabrir la composición acordada

**Files:**
- Create: `F/src/modules/quotes/QuoteEditor.tsx`, `EditQuotePage.tsx`, `components/QuotePackagesEditor.tsx`, `packageSelection.ts`.
- Modify: `F/src/modules/quotes/NewQuotePage.tsx`, `QuoteDetailPage.tsx`, `manifest.ts`, `F/src/App.tsx`.
- Modify: `F/src/services/quoteService.ts`.
- Create: `F/tests/packages.quote-form.test.cjs`, `packages.quote-scope.test.cjs`.

**Interfaces:**
- `QuoteEditor({mode:'create'|'edit', initialQuote?})` reutiliza la lógica comercial actual de NewQuotePage; NewQuotePage pasa `mode:create`, EditQuotePage carga documento y exige DRAFT antes de editar.
- `QuotePackagesEditor({value:PackageSelection[], onChange, preview, disabled})` permite elegir variante/opciones/cantidades y solicita preview al servidor con debounce/cancelación de peticiones.
- `packageSelection.ts` contiene solo normalización de entradas y validación de faltantes para UX, no precios financieros autorizados.
- `CreateQuotePayload.packages?`, `Quote.packageGroups?`, `Quote.integration_revision?`, `QuoteLine.package_component_key?`. Crear y exportar `UpdateQuotePayload = Partial<CreateQuotePayload> & {expectedRevision?:string}` y adaptar `updateQuote` para recibirlo y aceptar opciones de petición igual que `createQuote`. Mantener nombres de campos actuales para artículos libres y compatibilidad del cambio aislado de condición de pago.
- Ruta nueva `/cotizaciones/:id/editar`, permiso `quotes.create` y protección de borrador; detalle incluye «Editar cotización» solo si es admisible.

- [x] **Step 1 — Pruebas rojas del acuerdo.** `flavor_quantities_are_agreed_before_send` selecciona paquete 160 y cantidades 80+80, verifica texto «160 de 160» y payload de opciones, nunca precios de paquete aportados por cliente. `partial_draft_is_saved_and_reopened` guarda 80 de 160, reabre la misma selección y muestra «Falta completar la selección» / «Total pendiente de completar»; enviar está deshabilitado con motivo.
- [x] **Step 2 — Pruebas rojas de separación y revisión.** `two_groups_share_product_without_cart_merge` conserva identidades; `preview_from_previous_tenant_or_selection_is_ignored` usa cambio de sucursal o variante mientras hay petición en curso; `editing_existing_quote_keeps_saved_package_price` carga el acuerdo sin revalorizarlo con catálogo actual. `stale_revision_does_not_overwrite` muestra conflicto y conserva entradas locales.
- [x] **Step 3 — Verificar rojo.** En F: `node --test tests/packages.quote-form.test.cjs tests/packages.quote-scope.test.cjs`.
- [x] **Step 4 — Implementar formulario compartido.** Extraer la creación actual a QuoteEditor preservando selección de cliente, precios de artículos sueltos, unidades, permisos y guardas de borrador. Agregar acción secundaria «Agregar paquete»; editar selección en secciones inline, no en un modal grande. Cantidades y grupo quedan visibles con subtotales; los componentes incluidos no tienen control independiente de precio/eliminar. «Quitar paquete» elimina el grupo completo únicamente en DRAFT. Ninguna selección automática de sabores/cantidades. Guardar recibe snapshot validado del servidor y su nueva revisión, sin convertir una captura de preview en autoridad financiera.
- [x] **Step 5 — Reabrir y cerrar.** Cargar los artículos sueltos aparte de las partidas incluidas, inicializar selecciones desde grupos guardados, no desde el catálogo más reciente. Mantener la opción anterior visible en lectura si ya no está disponible, con mensaje accionable; no sustituirla por la primera opción. Guardar borrador y enviar son acciones distintas. Refrescar/recalcular paquete exige acción explícita y revisión del precio.
- [x] **Step 6 — Verificar verde y regresión.** Nuevas pruebas y `tests/quotes.service-conditions.test.cjs`, `quotes.sale-draft.test.cjs`, `services-commercial-documents.test.cjs`, `units-documents-ui.test.cjs` PASS; build PASS. Probar flujo completo con datos sintéticos después de disponer de migración aislada; no crear datos de DonShot en la empresa real. Checkpoint propio.

## Task 7: Mostrar el acuerdo y proteger datos en páginas/PDF/API existentes

**Files:**
- Create: `F/src/components/shared/CommercialPackageSummary.tsx`.
- Modify: `F/src/modules/quotes/QuotePresentation.tsx`, `QuoteDetailPage.tsx`, `PublicQuotePage.tsx`, `documents/generateQuotePDF.ts`.
- Modify: `F/src/modules/orders/pages/OrderDetailPage.tsx`, `PublicOrderPage.tsx`, `F/src/modules/orders/documents/generateOrderPDF.ts`, `F/src/services/orderService.ts`.
- Modify: `F/src/modules/sales/components/SaleDetailContent.tsx`, `F/src/modules/sales/types.ts`, `manualSalesApi.ts` y `F/src/modules/appointments/commercialApi.ts` en su DTO de contratación; `F/src/modules/appointments/pages/EngagementDetailPage.tsx` muestra el resumen dentro de su vista comercial existente.
- Modify: `B/src/modules/quotes/controller.js`, `B/src/modules/orders/controller.js`, `B/src/modules/appointments/commercialQueries.js`, `B/src/modules/integrations/documents.js`.
- Modify: `F/src/components/customer-pages/types.ts`, `documentAdapters.ts`, `blocks/QuoteBlocks.tsx`, `blocks/OrderBlocks.tsx` para incorporar la proyección pública al contexto y agrupar las partidas oficiales. No modificar la compilación, el sandbox, permisos de código o políticas de publicación de páginas personalizadas.
- Create: `B/tests/packages.public.test.js`, `F/tests/packages.presentation.test.cjs`.

**Interfaces:**
- `CommercialPackageSummary({groups, lines, mode:'quote'|'order'|'sale'|'engagement'|'public'})` renderiza la proyección comercial: encabezado de grupo, variante, composición, cantidades e importes; nunca añade el encabezado al total.
- `publicPackageGroups` de Task 3 es la única proyección para respuestas públicas/API; el contrato público de facts agrega un array opcional `packageGroups` sin romper plantillas existentes.

- [x] **Step 1 — Pruebas rojas de presentación.** `public_agreement_omits_private_fields` construye un fixture con costos/pesos/IDs privados sentinela y comprueba su ausencia serializando respuesta pública, facts y documento leído por API. `package_heading_does_not_duplicate_total` verifica una sola suma en detalle/PDF. `partial_sale_labels_only_invoiced_components` muestra acordado versus facturado sin aparentar entrega completa. `old_template_without_groups_renders_unchanged` conserva plantillas publicadas antiguas.
- [x] **Step 2 — Verificar rojo.** En B: `node --require ./tests/setup-env.js --test tests/packages.public.test.js`. En F: `node --test tests/packages.presentation.test.cjs`.
- [x] **Step 3 — Implementar las proyecciones y vistas.** La página compartida y el PDF muestran variante y distribución acordadas, no el catálogo actual. En venta los componentes facturados se identifican por la clave y sus importes vendidos; el total comercial original se etiqueta como referencia, no como otro cobro. La contratación explica por separado qué está acordado y qué está programado. Los facts de páginas personalizadas solo reciben campos comerciales públicos validados; no expandir la capacidad de código o acceso al sistema.
- [x] **Step 4 — Compatibilidad API del bloque 1.** `quotes.read` / `orders.read` pueden ver el desglose público de sus documentos propios enriquecidos internamente, sin nuevos permisos. No exponer todavía el catálogo global de paquetes ni habilitar entradas `packages`: esas rutas/scopes pertenecen al bloque 3. Preservar los recibos de creación y de edición ya persistidos; no reescribirlos para añadir grupos.
- [x] **Step 5 — Verificar verde.** Nuevas pruebas y las suites existentes de `public-quote-presentation`, `public-order-presentation`, `commercial-pdf-layout`, `customer-pages.renderer` de F; `customerPages.public`, `customerPages.schema`, `integrations.documents` e `integrations.mutation-http` de B PASS. Revisar visualmente el PDF y la página compartida en el entorno sintético, sin publicar una plantilla real. Checkpoint propio.

## Task 8: Aceptación del bloque y preparación de despliegue

**Files:**
- Create: `B/tests/packages.acceptance.pg.e2e.js`, `B/docs/inventario/paquetes-comerciales.md`.
- Update: este plan, con resultados y casillas reales; no marcar tareas incompletas como entregadas.

**Interfaces:**
- Reutiliza el fixture PostgreSQL desechable y todas las interfaces anteriores. No necesita otra API ni utilidades operativas con credenciales reales.

- [ ] **Step 1 — Aceptación sintética.** Crear productos de dos sabores, ingrediente, servicio y paquete con precio cerrado; guardar selección incompleta; completar 80+80 durante cotización; enviar/aceptar; cambiar catálogo; convertir por cada ruta admitida en escenarios separados; entregar/facturar/devolver parcialmente y comprobar importes, reserva y stock. Una selección no confirmada no genera pagos, horarios ni FEL.
- [ ] **Step 2 — Aislamiento y condiciones adversas.** Dos empresas/sucursales; dos grupos con mismo producto; usuario sin permiso; producto/servicio deshabilitado; cambio de unidad; moneda no coincidente; conflicto de revisión; reintento tras respuesta perdida; excepciones intermedias con rollback. Datos antiguos y claves/recibos previos permanecen iguales.
- [ ] **Step 3 — Verificación global.** En B `npm run test:unit` y `npm run test:modules`; en F `node --test tests/*.test.cjs tests/*.test.mjs`, `npm run test:modules` y `npm run build`. Registrar errores preexistentes separadamente, sin adjudicarlos ni ocultarlos. PostgreSQL aislado debe tener resultados de migración y concurrencia; si no puede levantarse, no declarar lista la migración.
- [ ] **Step 4 — Revisar diff completo.** Comprobar que solo se añadieron cambios propios, que ningún endpoint usa precios/snapshots aportados como autoridad, que no existe nueva llamada a Infile y que el encabezado no duplica ingresos. Revisar el alcance respecto de la spec, incluyendo todos los destinos y no solo el alta de catálogo.
- [ ] **Step 5 — Documentar y entregar.** Explicar dónde se crean paquetes, cómo se acuerdan cantidades y cómo se distinguen kits físicos de servicios/equipos; documentar límites y lo pendiente de bloques 2/3. Proporcionar resultados de tests/build/pruebas aisladas, rutas de pantallas y archivos. Solicitar autorización de aplicación de la migración a la base activa solamente después de esos resultados; no inferirla de aprobaciones antiguas. No afirmar que DonShot ya está conectado.

## Criterio de salida y continuación

El bloque 1 estará terminado cuando un usuario autorizado pueda crear un paquete,
acordar su composición en una cotización, reabrirla, compartirla y convertirla sin
perder precios, cantidades u origen, y los escenarios de parcialidad/devolución
conserven dinero/stock. No basta un catálogo, un endpoint o pruebas de parser.

Queda pendiente, con planes separados, la operación avanzada de recursos y pagos
del bloque 2 y las nuevas capacidades externas del bloque 3. Hasta entonces, las
pantallas no presentarán esos requisitos como automatizados.
