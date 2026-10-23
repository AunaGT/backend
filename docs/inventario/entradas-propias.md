# Productos, compras y fabricación sencilla

## Crear un producto

Nombre, categoría y precio permiten crear el producto. Proveedor habitual es opcional y puede quitarse al editar. Si se indica uno, debe pertenecer a la empresa activa. La importación también acepta proveedor vacío. Los servicios siguen sin proveedor ni movimientos físicos de inventario.

## Registrar una entrada

Desde Mercancía → Nueva entrada, elegir el origen:

- **Compra a proveedor:** seleccionar el proveedor real de esa entrega. Puede ser distinto del habitual del producto. Conserva condiciones y registro de pagos.
- **Fabricación propia:** seleccionar un producto terminado, cantidad producida en su unidad de inventario y costos del lote completo. Materiales no inventariados, mano de obra y otros costos se indican por separado. La sección opcional de materiales de inventario permite descontar insumos existentes; su costo se calcula en el servidor, sin volver a capturarlo como gasto manual.
- **Existencias iniciales:** agregar productos, cantidades y costo por unidad. Son entradas que se suman a las existencias, no compras nuevas ni cuentas por pagar.

Una confirmación explica qué se registrará. La fabricación y la apertura no admiten proveedor ni campos de pago, incluso desde la API. En el historial se muestra el origen, y la fabricación conserva el desglose de materiales y costos. Los reintentos de una misma solicitud no duplican documentos ni stock.

La cantidad de fabricación/apertura usa siempre la unidad base mostrada en el formulario; la compra conserva las presentaciones comerciales existentes. El costo promedio del producto se actualiza al confirmar. Registrar un costo no registra automáticamente un gasto pagado ni un asiento contable.

## Límites deliberados

Este flujo registra fabricación ya terminada: no incluye planificación industrial, órdenes de trabajo ni recetas permanentes. Los kits conservan su función de armado. Se mantienen las políticas FEFO y caducidad existentes, sin agregar un bloqueo nuevo de insumos vencidos.

La migración aditiva `20261023190000_own_receipts` permite proveedores nulos en apertura y agrega origen/desglose de producción; no elimina registros ni cambia los movimientos históricos.
