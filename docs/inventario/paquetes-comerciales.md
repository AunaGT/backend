# Paquetes comerciales

Un paquete agrupa productos y servicios con un precio cerrado. No es otro producto
físico, no genera otro movimiento de inventario ni suma un segundo ingreso.

## Crear y ofrecer un paquete

1. Abre **Inventario → Paquetes** (`/inventario/paquetes`). Necesitas consultar
   productos; guardar, activar o archivar requiere editar productos.
2. Crea un paquete y selecciona sus sucursales. Las variantes pueden representar,
   por ejemplo, 80/160 shots, una sesión con materiales o un conjunto de productos.
3. Agrega los productos/servicios siempre incluidos y, cuando corresponda, las
   elecciones del cliente. En «Sabores» puedes definir 160 unidades y hasta dos
   opciones diferentes. Las opciones deben compartir unidad, factor y precisión.
4. Define el precio y los pesos de venta para distribuirlo entre las partidas
   reales. Los pesos no son costos; un peso cero indica un componente incluido
   sin cargo. Revisa la distribución estimada antes de activar.
5. Guarda el borrador y activa esa versión. Un cambio posterior del catálogo
   requiere guardar y activar una versión nueva, sin modificar acuerdos anteriores.

La moneda es la de la empresa. Un servicio requiere tener habilitados los
servicios de inventario. Las presentaciones conservan su revisión y factor.
El editor usa los mismos controles, alertas y guardas de borrador de Auna.

## Acordar la composición al cotizar

En **Nueva cotización** agrega un paquete y su variante. Las cantidades de las
opciones se escriben durante la negociación: por ejemplo, 80 de limón y 80 de mora.
No se asigna automáticamente el sabor ni se mezclan dos paquetes aunque tengan
el mismo producto.

Puedes guardar un borrador incompleto y reabrirlo desde **Editar cotización**.
El total permanece pendiente; no permite enviar, compartir, descargar una propuesta
terminada, aceptar ni convertir hasta completar la selección. Las partidas
incluidas no se cambian como artículos sueltos: se edita o quita el grupo completo.

Reabrir conserva la selección y los precios guardados, además de los descuentos
del documento. No actualiza automáticamente al catálogo nuevo. Si la versión ya
no se ofrece y deseas usar la actual, quita el paquete, agrégalo otra vez y revisa
sus opciones/precio. Si otra persona modifica el borrador, se pide revisar la
versión actual y se conservan las entradas locales; no se sobrescribe en silencio.

## Continuar la operación

- **Pedido:** conserva el acuerdo y permite seguir el flujo de entregas/facturas.
  Los documentos parciales conservan la identidad y el importe de cada componente.
- **Venta desde cotización:** crea primero un borrador, no un cobro ni una factura
  certificada. Cliente, partidas y descuentos se mantienen.
- **Agenda:** conserva lo contratado. Programar horarios, responsables y recursos
  es una operación separada. Un producto físico nunca va al calendario.
- **Devoluciones:** usan la partida y el importe neto vendidos, no el precio actual
  del catálogo. Dos grupos con un mismo producto no pierden su identidad.

Un kit físico sigue usando su operación de inventario existente. La fabricación
propia consume ingredientes al producir; al vender el paquete se descuentan los
productos terminados, no los ingredientes por segunda vez. Un servicio no mueve
stock. Mesas, vehículos, barras y personas son recursos operativos, no componentes
vendidos salvo que realmente se comercialicen como productos/servicios.

## Páginas compartidas y API

Detalle, página compartida y PDF muestran la variante y composición guardadas.
Una venta parcial muestra solo las partidas facturadas y etiqueta el acuerdo
original como referencia, nunca como otro cobro.

Las páginas personalizadas reciben `packageGroups` opcional en sus datos públicos
y las partidas identifican su grupo. Las plantillas antiguas funcionan igual.
Se excluyen selección técnica, costos, pesos, revisiones internas y recursos
privados. No se amplían el sandbox ni los permisos del código personalizado.

Las claves con `quotes.read` / `orders.read` pueden leer el desglose público de
sus documentos propios. No obtienen acceso al catálogo global ni permiso para
crear o editar paquetes por API. Los recibos de operaciones previas no se alteran.

## Límites y siguientes bloques

Se admiten hasta 100 partidas reales en la cotización, con cantidades e importes
decimales validados por el servidor. No se aceptan precios/snapshots de paquetes
aportados por el navegador como autoridad.

El **bloque 2** queda para requisitos avanzados de recursos, hitos, transporte y
políticas de anticipos. El **bloque 3** queda para catálogo externo de paquetes,
selecciones por API y disponibilidad pública. Este bloque no conecta DonShot,
no publica una plantilla real y no hace llamadas a Infile.

## Verificación y despliegue

La migración aditiva `20261026120000_commercial_packages` ya fue aplicada con
autorización explícita a la base de localhost. Los documentos antiguos mantienen
sus campos nuevos vacíos; las claves, permisos y recibos previos no se modifican.

Pruebas de dominio: `tests/packages.*.test.js` y pruebas de interfaz homónimas.
Las pruebas PostgreSQL son optativas y rechazan URLs que no sean de una base
desechable local llamada `auna_packages_test_*`: primero migración en base vacía,
después concurrencia y aceptación. Nunca uses la URL de la aplicación.

La aceptación PostgreSQL recorre borrador incompleto → composición 80+80 →
envío/aceptación → cambio de catálogo → pedido/venta borrador/Agenda en escenarios
separados, con revisión, permisos, reintento y rollback. Entregas parciales,
devoluciones y producción se verifican además con los servicios reales de dominio
y persistencia sintética controlada en sus pruebas específicas.
