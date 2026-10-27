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

Si después cambias la moneda de la empresa, Auna no convierte precios ni cambia
la moneda de los acuerdos anteriores. Impide seguir operando un paquete/acuerdo
en una moneda distinta hasta revisarlo; las propuestas guardadas y sus PDF siguen
mostrando su moneda original. No es una función de cambio de divisas.

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

Puedes elegir otra sucursal autorizada en el editor sin cambiar la sucursal global.
El catálogo usa la sucursal elegida; cambiar de empresa o sesión descarta respuestas
que todavía estén llegando del contexto anterior.

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

El **bloque 2a** añade los requisitos de personal y equipo descritos debajo.
El **bloque 2b.1** agrega momentos y horarios propios, pendiente de desplegar su
migración. **2b.2/2c** quedan para zonas/cargos de transporte y políticas de anticipos.
El **bloque 3** queda para catálogo externo de paquetes,
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

## Personal y equipo necesarios — bloque 2a

En el producto de tipo **Servicio → Agenda → Requisitos específicos** puedes
definir, por ejemplo, «Equipo de atención: 2 profesionales» y «Barra: 1 equipo».
Primero habilita las personas y equipos del servicio; después indica las opciones
que pueden cubrir cada requisito. Habilitar tres barras no obliga a reservar las
tres. Una misma persona o equipo no cubre dos plazas, aunque tenga varios perfiles.

El sistema comprueba que cada sucursal y lugar ofrecido tenga opciones suficientes.
Una sala fija no sirve como equipo transportable para un evento externo. No se
multiplican estos requisitos por las horas vendidas: corresponden a cada programación.
Se admiten hasta 20 requisitos, 20 plazas por requisito y 40 plazas en total.

Al programar, Agenda muestra cuántas plazas cubre tu selección. Esa indicación no
reserva ni certifica disponibilidad: al guardar se validan identidades, calendarios,
ausencias, otras actividades y el intervalo completo de preparación/traslado/cierre.
Una selección parcial no se completa con otra persona o equipo en silencio. Una
consulta sin selección puede proponer un conjunto completo disponible.

Las cotizaciones nuevas conservan el nombre, tipo y cantidad requeridos, nunca
las opciones privadas o datos del personal. Cambiar el catálogo no modifica el
acuerdo anterior ni sus importes. Antes de programar se revisan las condiciones
actuales. Las sesiones ya creadas conservan sus propias reglas al inscribir o
reprogramar; no reciben nuevas obligaciones por un cambio posterior del catálogo.

La lista vacía conserva el comportamiento anterior. Los clientes antiguos que
omiten el campo no borran los requisitos guardados. La edición usa la revisión
del perfil existente y las reservas mantienen el bloqueo y recibos de Agenda.

La migración aditiva `20261027120000_service_assignment_requirements` agrega solo
el campo de requisitos; fue ensayada en PostgreSQL temporal y aplicada con
autorización explícita a la base que usa localhost. Se regeneró el cliente de datos,
se verificó que los datos anteriores permanecieran iguales y se reinició el backend.
Las pruebas optativas `appointments.requirements-*.e2e.js` usan solo una
URL explícita local `APPOINTMENTS_REQUIREMENTS_TEST_DATABASE_URL` cuya base se
llame `auna_requirements_test_*`. Nunca uses la URL de la aplicación.

Este tramo no añade hitos, intervalos individuales nuevos, precios de transporte,
anticipos ni integración web/API de paquetes. DonShot e Infile siguen pendientes.

## Momentos y horarios propios — bloque 2b.1

En **Agenda → Nueva programación → Actividad**, o al programar un servicio de
tipo **Trabajo o evento**, el horario general sigue siendo suficiente. No tienes
que crear momentos ni horarios propios si todo el personal y equipo permanece
durante el mismo intervalo.

- **Momentos del evento:** agrega, por ejemplo, «Bienvenida» o «Show», con nombre,
  inicio y fin. Se muestran con fechas/horas de la zona del evento. Un momento no
  crea otra reserva, otro cobro ni una partida comercial.
- **Horarios del personal y equipo:** cada asignación empieza en «Todo el evento».
  Usa «Horario propio» solo si llega o sale a otra hora. Revisa y confirma sus
  minutos de ida, preparación, cierre y regreso; se muestra desde cuándo y hasta
  cuándo se reserva. Los invitados no reservan disponibilidad.
- **Responsable interno:** permanece durante todo el intervalo operativo. Si es
  también un profesional, sus asignaciones se suman: no queda libre usando otra
  ficha de la misma persona.
- **Requisitos del servicio:** «Todo el evento» exige cobertura completa, incluida
  la logística. «En un momento del evento» permite elegir el momento al programar;
  todas sus plazas deben cubrir ese momento completo. Dos intervenciones
  consecutivas no cubren dos personas necesarias al mismo tiempo.

Cambiar el inicio desplaza los horarios con el evento. Acortarlo no recorta
momentos ni presencia: pide corregir los que queden fuera. Quitar una asignación
o cambiar requisitos tampoco borra sus horarios en silencio; se revisan antes de
guardar. Los borradores conservan entradas incompletas, pero no se guardan como
programaciones válidas hasta completarlas.

El detalle muestra el cronograma y las reservas por persona/equipo. Las citas y
clases no reciben nuevos formularios; sí respetan estos intervalos al consultar
disponibilidad. Los requisitos de sesiones existentes siguen congelados aunque
después se modifique el servicio.

**Despliegue pendiente:** `20261028120000_activity_operational_timeline` se prueba
solo en PostgreSQL desechable. Antes de habilitarlo en localhost se necesita
autorización para aplicar esa migración, después regenerar el cliente activo y
reiniciar el backend. Hasta entonces los controles nuevos explican que falta la
actualización y la programación anterior sigue funcionando. No se deben invertir
esos pasos.

No agrega cargos de transporte, anticipos, disponibilidad pública, permisos de
API, recursos a las páginas compartidas ni integración con DonShot/Infile.
