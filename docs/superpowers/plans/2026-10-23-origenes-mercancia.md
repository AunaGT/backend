# Proveedor opcional y entradas propias — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Crear bienes sin proveedor, comprar a cualquier proveedor autorizado y registrar producción/apertura sin inventar compras.
**Architecture:** Conservar el catálogo y el documento de entrada existentes. PURCHASE mantiene pagos; INITIAL y PRODUCTION permiten proveedor nulo y nunca generan cuentas por pagar. Una producción registra un producto terminado, sus insumos reales y costos manuales no inventariados; se confirma atómicamente y con idempotencia.
**Tech Stack:** React/TypeScript, Express, Prisma/PostgreSQL; componentes Auna y aritmética Decimal existentes.
**Spec:** Alcance aprobado en conversación: ficha sin proveedor obligatorio; entradas por compra, fabricación propia y existencias iniciales, con costos, trazabilidad e insumos descontados cuando se controlan en inventario.

## Global Constraints

- No fabricar proveedores ficticios ni convertir servicios en bienes; conservar aislamiento empresa/sucursal y permisos existentes.
- No sustituir cantidades exactas por Number; costo unitario derivado hasta 12 decimales, totales monetarios a 2.
- No borrar datos, reiniciar bases, instalar dependencias ni incluir cambios ajenos. Migración aditiva sin backfill destructivo.
- Producción sencilla por lote, no planificación industrial/MRP ni asientos contables nuevos. Costos registrados no equivalen a pagos.
- Mantener el código existente de stock/ubicaciones/lotes como único escritor físico.

## Review Focus

1. Reintento tras respuesta perdida: la misma clave debe devolver el mismo documento sin mover stock dos veces.
2. Insumo de otra empresa, servicio, kit o producto terminado usado como su propio insumo: rechazar antes de escribir.
3. Falta de insumos o caducidad: rollback de insumos, producto terminado y documento.
4. Fabricación/apertura no debe poder recibir pagos ni figurar como deuda o compras operativas.
5. Cambiar origen/empresa durante edición o envío no debe reutilizar campos o respuestas de otro contexto.

### Task 1: Proveedor opcional en catálogo y compras flexibles

**Files:** backend products.controller.js, bulkImport.js; frontend useProductForm.ts, ProductCreatePage.tsx, ProductDetailPage.tsx, ProductPicker.tsx y RegisterIncomingMerchandise.tsx; pruebas de contratos.
**Interfaces:** supplier_id omitido/null/vacío normaliza a null; proveedor informado conserva validación de pertenencia. PURCHASE exige proveedor del documento, no coincidencia con proveedor habitual.
- [ ] Pruebas RED para crear con stock sin proveedor, quitar proveedor al editar y validar importación sin proveedor.
- [ ] Quitar obligatoriedad en ambos extremos, mantener movimientos INITIAL sin purchaseLog si no hay proveedor.
- [ ] Retirar filtro de proveedor del selector de compra y rechazo de proveedor distinto en recepción.
- [ ] Verificar contratos y regresiones.

### Task 2: Recepciones propias atómicas

**Files:** prisma/schema.prisma, migración nueva; services/ownReceipts.js; products.controller.js; merchandise/controller.js y payables/balance.js/compatibility.js; pruebas own-receipts.test.js.
**Interfaces:** source INITIAL|PRODUCTION, request_key, items; PRODUCTION exactamente un terminado con quantity en unidad base, components:[{product_id,quantity}], costs:{materials,labor,other}, notes/location_id/lote/caducidad. Retorna incomingMerchandise y costos autoritativos. El servidor rechaza campos de pago/proveedor en entradas propias.
- [ ] Pruebas RED para costos exactos, insumos, pertenencia, tipos, repetición y rollback.
- [ ] Agregar PRODUCTION a enums de entrada/movimiento, supplier nullable y production_details JSON en entrada.
- [ ] Registrar con bloqueo de empresa/productos, stock existente, lotes y clave de reintento para ambos modos de unidades.
- [ ] Hacer listados/detalle/exportes tolerantes a entradas sin proveedor y excluir todos los no PURCHASE de pagos.
- [ ] Validar esquema/generar cliente local; no aplicar migraciones ajenas.

### Task 3: Experiencia guiada y verificación

**Files:** RegisterIncomingMerchandise.tsx, nuevo OwnReceiptForm.tsx, tipos/detalle de mercancía; pruebas UI.
**Interfaces:** selector de origen común; compra conserva flujo actual; entradas propias usan formulario dedicado y compacto con costos desglosados y opción de insumos inventariados.
- [ ] Pruebas RED de origen, campos visibles, envío sin proveedor/pagos, conservación de datos y contexto.
- [ ] Implementar campos accesibles, mensajes claros, selector de productos físicos, confirmación/notificaciones Auna y detalle de costos guardados.
- [ ] Correr suites completas de ambos proyectos, build y límites de módulos; revisar diff y revisión independiente final.

## Execution record

- Ruling: trabajar en los checkouts actuales de Modularizado, sin worktree ni commits automáticos: la implementación depende de muchos cambios locales existentes del usuario; crear uno desde HEAD perdería esas dependencias.
- Ruling: el usuario delegó las decisiones y pidió hacerlo sin más preguntas; este plan documenta el alcance aprobado y se ejecutará en esta sesión.
- Task 1: implementado; contratos de proveedor opcional y precios de servicio verificados. Importación permite proveedor vacío; el proveedor informado conserva validación de empresa. Contratos antiguos que lo exigían actualizados a la regla aprobada.
- Task 2: implementado; own-receipts 8/8 RED→GREEN, detalle/pagos 10/10. Se agregó comprobación de stock reservado antes de consumir. Migración 20261023190000_own_receipts validada, cliente regenerado y aplicada; migrate status mostraba únicamente esta pendiente. No se crearon productos, compras ni producciones en la base conectada.
- Task 3: formulario guiado implementado; pruebas UI propias 3/3, contratos UI relacionados 47/47. Pendiente cerrar suites generales y revisión independiente.
- Ruling: producción usa cantidades en la unidad base explícitamente indicada; no introduce conversión de presentaciones en fabricación. Reduce errores y conserva el flujo comercial actual de compra por presentación.
- Ruling: mantener compras reales en PurchaseLog y producción en su documento/stock_movements; los costos declarados no generan pagos ni asientos contables automáticos. No duplicar gastos existentes del cliente.
- Final review: independiente por own_receipts_review. Dos hallazgos importantes (apertura ausente de reportes financieros y PDF con estado de deuda) corregidos RED→GREEN en own-receipts y merchandise.detail. La apertura conserva la valoración INITIAL en PurchaseLog con proveedor nulo, una sola vez por solicitud; nunca se etiqueta PURCHASE.
- Final review: el hallazgo de costo inicial sugerido de 12 decimales se elevó de menor a importante por bloquear un formulario válido; frontend y backend aceptan la precisión existente de 12 sin truncarla. Pruebas own-receipts/own-receipts-ui RED→GREEN.
- Final: Ruling: conservar la política FEFO/vencimientos actual para insumos: este flujo registra fabricación ya realizada, no una orden planificada ni una autorización sanitaria. No se agrega un bloqueo nuevo de material vencido; clientes que necesiten esa política requieren una regla explícita transversal.
- Final: Ruling: planificación industrial y nuevos asientos contables están fuera del alcance aprobado. La confirmación sí actualiza existencias y costos; costo no implica pago.
- Final: Ruling: no efectuar producciones ni compras de prueba contra los datos conectados. Cobertura con transacciones/stock simulados y pruebas reales de los escritores existentes; concurrencia real y revisión visual no verificadas en esta tarea.
- Final verification: backend npm test 1364/1364 (27431 ms); frontend node --test tests/*.test.cjs 1262/1262 (127125 ms); build correcto (1m38s); 23 límites de módulos correctos; git diff --check limpio en ambos proyectos. TypeScript conserva únicamente TS2554 previo en frontend src/modules/appointments/commercialApi.ts:11. Swagger de registro de entradas validado. migrate status confirma base actualizada.
- Tasks 1–3: complete. Ningún hallazgo crítico/importante pendiente de la revisión; la precisión inicial se corrigió pese a su calificación inicial de menor. Cambios locales conservados sin commits, merge ni publicación; no se elimina este registro porque no se comprometió a Git.

## Follow-up: proveedor opcional y CHECK desplegado

- El guardado real reportó PostgreSQL 23514: la migración anterior dejó vigente `products_service_fields_check`, que aún exigía proveedor para STANDARD/KIT. Las pruebas simuladas no detectaron esa restricción de la base.
- Añadida y aplicada `20261023200000_optional_product_supplier_check`, sin modificar migraciones ya aplicadas ni datos. Solo retira la exigencia de proveedor para bienes; conserva todas las reglas de servicios, kits y precisión. Reemplazo atómico y espera de bloqueo limitada a 5 segundos.
- Nueva prueba de integración de solo lectura `tests/products.supplier-constraint.dev.e2e.js`: evalúa el CHECK realmente desplegado sobre registros sintéticos. RED en STANDARD/KIT sin proveedor antes de la migración; GREEN después, 19 escenarios (20 pruebas incluyendo el contenedor). No crea ni actualiza productos.
- Verificación: backend `npm test` 1364/1364; integración PostgreSQL 20/20; `migrate status` actualizado; `git diff --check` limpio. No se verificó el formulario en navegador ni se alteraron productos del usuario.
