# Implementación de entregas y ventas independientes

Especificación: [decisión de producto](ORDER_FLOW_PRODUCT_DECISION.md).

## Decisiones de implementación

Los pedidos existentes conservan LEGACY; los nuevos usan SEPARATE. La venta
directa sigue siendo el flujo inicial de mostrador. Entregar no requiere caja
ni método de pago. Facturar usa las cantidades entregadas todavía no vendidas,
con cobro de contado o crédito administrado por Cartera. Esta implementación
registra ventas internas; la certificación fiscal conserva su proceso existente.

## Trabajo y comprobaciones

- [x] Persistir entregas y cantidades facturadas por línea con migración aditiva.
- [x] Registrar entregas dentro de una transacción, bloqueando el pedido y
  validando tenant, sucursal, estado y cantidades; descontar inventario una vez.
- [x] Facturar cantidades entregadas bajo el mismo bloqueo; conservar el
  endpoint legacy e impedir su uso para duplicar existencias de pedidos nuevos.
- [x] Reutilizar Cartera para validar crédito, vencimiento y límite por cliente.
- [x] Separar acciones y saldos en el detalle; mantener paginación y temas.
- [x] Comprobar cantidades repetidas, vacías y excesivas, saldos sin ventas,
  permisos, activación de módulos y compatibilidad de pedidos anteriores.
- [x] Ejecutar pruebas de módulos, validación Prisma y compilación frontend.

La facturación anticipada, estados de transporte con evidencias y perfiles de
servicios requieren casos de uso propios; no se simulan con estados de venta.
El despliegue aplica primero la migración aditiva y regenera Prisma.

## Comprobación y estado de despliegue

Prueba integral local en PostgreSQL: dos entregas, reintentos, reversión de una
entrega sin facturar, entregas concurrentes, venta consolidada al crédito,
costo congelado por entrega, aplicación de abono en Cartera y aislamiento entre
empresas. Ejecutable: `tests/orders.separate.e2e.js`, restringido a la base de
pruebas local en el puerto 55439. `tests/orders.migration.sql` comprueba la
migración aditiva y la conservación del histórico dentro de una transacción.

Revisión: se corrigieron carreras con cancelación/vencimiento y se agregó
reversión de entregas sin ventas. Una entrega ya facturada se corrige mediante
el módulo existente de devoluciones; no se anula el movimiento físico cambiando
el estado de la venta.

La migración `20260924100000_order_deliveries` **fue aplicada en la base
compartida**, con autorización explícita del usuario, mediante
`npm run migrate:deploy`. La comprobación previa encontró únicamente esta
migración pendiente, ninguna fallida y 128 líneas con cantidades válidas.
Prisma completó la aplicación sin modificar ni reconciliar el historial remoto
heredado descrito en `DEPLOYMENT_AND_MIGRATIONS.md`. Ese historial sigue siendo
un asunto independiente; no se usó reset, db push ni resolución ficticia.

Esta entrega implementa el flujo de despacho con facturación manual posterior.
Los perfiles configurables, la facturación anticipada y las etapas de transporte
de la propuesta general quedan pendientes; no se presentan como implementados.
