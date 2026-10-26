# Paquetes comerciales de productos, servicios y recursos

Fecha: 2026-10-26
Estado: aprobado por el usuario el 2026-10-26. Se prepara el plan del bloque 1;
la aprobación no autoriza aplicar migraciones en la base activa sin su
verificación y solicitud correspondientes.

## Intención y decisiones del usuario

Auna debe poder guardar y operar lo que ofrece DonShot —shots, paquetes,
servicios, profesionales y equipos— mediante capacidades reutilizables para
otros negocios. El usuario solicitó corregir las carencias identificadas en
la revisión, sin construir un sistema exclusivo para DonShot.

Decisión confirmada: la distribución de productos y cantidades, incluidos los
sabores de un paquete, **se acuerda durante la cotización**. No es una decisión
que deba quedar pendiente hasta preparar el evento.

No se autorizaron emisiones, conexiones ni pruebas con Infile. No se necesitan
para este trabajo. Tampoco se crearán productos o credenciales reales sin una
acción explícita del usuario en los flujos correspondientes.

## Situación comprobada

- Inventario admite STANDARD, KIT y SERVICE, unidades, presentaciones, lotes,
  fabricación propia y proveedores opcionales.
- Fabricación propia consume ingredientes físicos y produce existencias con
  costo. Los kits existentes son composiciones físicas; no admiten servicios.
- Cotizaciones y pedidos admiten productos físicos y servicios; Agenda toma
  una cotización aceptada y conserva sus partidas en una contratación.
- Agenda tiene profesionales, recursos ROOM/EQUIPMENT, equipos transportables,
  eventos externos y ocupación ampliada por traslado, montaje y desmontaje.
- Las asignaciones de un perfil indican opciones habilitadas, no una lista de
  todo el equipo que necesariamente debe participar en cada contratación.
- La API externa admite catálogo y borradores comerciales, no administración
  de recursos ni programación externa. Su disponibilidad actual es de stock,
  no de horarios.
- DonShot mantiene en su código paquetes, precios por categoría, sabores,
  zonas de traslado y condiciones de pago. Su formulario no persiste en Auna.

## Alcance y límites

Implementar un paquete comercial configurable que agrupe artículos existentes
y servicios, sin añadir un cuarto tipo de producto ni alterar los kits físicos.
La composición acordada debe acompañar la cotización, el pedido, la
contratación y la venta, sin duplicar ingresos, movimientos ni reservas.

La definición del paquete es un catálogo versionado; una cotización conserva
una copia validada de la versión elegida. Modificar el catálogo no cambia lo
ya cotizado, aceptado, vendido o programado.

Fuera de alcance: reconstruir DonShot, importar sus registros automáticamente,
crear otro motor de inventario o contabilidad, pasarelas de pago, fabricación
industrial completa, facturación FEL, sincronización de empleados con una web
pública y un motor genérico de reglas o código ejecutable aportado por clientes.

## Experiencia comercial

1. Se configura un paquete con nombre, descripción, imagen, sucursales donde se
   ofrece, variantes, componentes fijos y grupos de elección.
2. Una variante define el precio y los límites de sus elecciones. Un grupo
   permite elegir artículos explícitos, limitar el número de opciones distintas
   y exigir una cantidad total. Las opciones pueden reutilizarse entre variantes.
3. Al agregarlo a una cotización se seleccionan la variante, los artículos y
   las cantidades. Ejemplo: 160 shots = 80 de un sabor + 80 de otro, solamente
   si la variante permite dos sabores. Es ilustrativo, no una regla predeterminada.
4. Se muestran por separado total acordado, composición, servicios incluidos,
   datos pendientes de programación, traslado y condiciones de pago.
5. Un borrador puede guardar una composición incompleta con un estado visible
   «Falta completar la selección». No puede enviarse ni aceptarse como propuesta
   cerrada, convertirse o confirmarse hasta satisfacer sus reglas.
6. Antes de enviar se validan sumas, número de opciones, productos habilitados,
   unidades, sucursal, moneda, servicios y precio autorizado. No se asignarán
   cantidades ni se repartirán sabores silenciosamente.
7. Aceptar la cotización fija el acuerdo comercial; **no equivale a reservar
   personal o equipo ni a recibir un pago**. Cada estado se muestra por separado.

Diseño de interfaz pendiente del plan: usar componentes del sistema, formularios
compactos y una página de edición del paquete, no un editor en un modal grande.
Las operaciones habituales de productos o servicios individuales no requieren
rellenar datos de paquetes. No se duplica el catálogo de productos por variante.

## Composición, precio y documentos

Decisión técnica propuesta: el paquete es un grupo comercial no contabilizable
por sí mismo. Sus componentes reales son las partidas de producto y servicio
que alimentan los mecanismos existentes. El encabezado visible del grupo no
genera otra partida con ingresos o stock.

El servidor calcula el precio de la variante y del traslado; no acepta como
verdadero un total aportado por la web. Para distribuir un precio cerrado entre
partidas se configuran ponderaciones de venta por componente o grupo, distintas
del costo. En grupos de productos elegibles, su parte se distribuye por la
cantidad acordada. Se utilizan decimales exactos, redondeo monetario y reparto
determinista del residuo en un orden estable. La suma de partidas coincide
exactamente con el precio acordado; una asignación no representable con las
unidades o precisión actuales exige revisión, nunca un ajuste oculto.

No se publica una variante con precio cerrado positivo sin distribución
comercial válida. No se infieren ponderaciones a partir de los costos privados.
Una partida gratuita puede tener precio cero explícito. Se conservan el precio
del grupo, la distribución y los importes por partida en la copia del acuerdo.
Las reglas fiscales y de descuento existentes se aplican a las partidas reales;
el paquete no introduce ni presume un tratamiento fiscal.

Los cambios manuales de precio requieren los permisos comerciales existentes,
motivo y un nuevo cálculo validado. Las API keys no adquieren ese permiso.

Cada documento conserva identificadores de grupo y origen, versión del paquete,
variante, reglas, selección, cantidades, importes, condiciones y datos de evento
acordados. La estructura se valida con un esquema acotado, no JSON libre.
Los cambios concurrentes devuelven conflicto y las operaciones reintentadas
reutilizan los recibos de idempotencia existentes.

Enviar, aceptar, editar, copiar, convertir a pedido o venta, contratar, entregar
parcialmente, facturar, cancelar, corregir y devolver deben respetar la misma
composición congelada. No se puede editar una partida incluida para evadir las
reglas del grupo. Un cambio de alcance aceptado usa los flujos existentes de
corrección y revisión de vinculaciones; nunca reescribe ventas o reservas previas.

Una entrega o facturación parcial actúa sobre cantidades de componentes reales
y no vuelve a cobrar el encabezado del paquete. Los saldos se calculan desde las
asignaciones monetarias conservadas, sin recalcular el precio con el catálogo
actual. Las vistas y PDF indican qué se está cobrando o entregando.

## Existencias y preparación

La cotización no consume stock. Las reservas, entregas y ventas siguen los
momentos establecidos por los módulos actuales. Se verifican nuevamente sus
cantidades al confirmar las operaciones correspondientes.

El paquete referencia productos físicos preparados, por ejemplo shots. La
fabricación propia registra ingredientes y obtiene existencias de esos productos.
Vender el paquete descuenta los productos terminados: no vuelve a descontar sus
ingredientes. Si se usan kits físicos en otro negocio, se respeta su mecanismo
actual y se prueba que sus componentes no se consuman dos veces.

Los equipos y profesionales no son componentes consumibles ni una cantidad de
stock del paquete. Su ocupación se gestiona en Agenda. No se crea automáticamente
un vínculo contable entre un recurso de Agenda y una ficha de inventario.

## Servicios, recursos y programación

Un servicio puede declarar requisitos de profesionales y de equipos. Un requisito
tiene nombre, cantidad y opciones elegibles de la misma empresa y sucursal.
Ejemplo: un carrito elegido entre carritos habilitados y un profesional entre
personas calificadas. El sistema valida el conjunto asignado, no solo la
presencia de cualquier recurso. Requisitos diferentes no pueden satisfacerse
reutilizando la misma unidad física o persona salvo una compatibilidad explícita
en el diseño del servicio; por defecto son asignaciones distintas.

Los requisitos forman parte de las condiciones versionadas del servicio. La
contratación conserva lo cotizado y exige la comparación/revisión actual de
Agenda si cambia la configuración. La identidad de la persona o equipo concreto
se acuerda internamente al programar, no necesariamente al cotizar.

Los intervalos se crean con los servicios y bloqueos actuales de Agenda. Para
un equipo que permanece en el evento se reserva todo su intervalo operativo,
con los tiempos de traslado, preparación y desmontaje. Las intervenciones del
show se guardan como hitos dentro de ese intervalo y no duplican el bloqueo del
mismo equipo o profesional. Un participante que solo asiste a una intervención
puede tener su intervalo independiente. Se comprueba disponibilidad real y
conflictos dentro de la transacción; una lectura previa no garantiza una reserva.

La cotización puede guardar fecha, ubicación y horarios solicitados. Sin hora
real de inicio y fin se muestra «Pendiente de programación», no «Disponible».
No se confirma una programación incompleta ni se cambia una reserva existente
por aceptar una cotización diferente.

## Traslado y condiciones de pago

El negocio configura zonas con cargo fijo o «Requiere cotización», y puede
asociar instrucciones. Son reglas explícitas, no inferencias por texto libre,
geolocalización ni valores propios de DonShot. El cargo utiliza un servicio de
traslado existente y queda fuera del precio base para no cobrarlo dos veces.
Una zona sin precio bloquea el cierre del precio hasta que un usuario autorizado
lo acuerda y guarda. Tiempo de viaje y cargo monetario son datos independientes.

Las condiciones de pago pueden expresar anticipo porcentual y saldo exigible
ciertos días antes de un evento; los valores son configurables y no tienen
50 % ni siete días como predeterminado. Se conservan en la cotización aceptada.
Se reutilizan cobros, compromisos, saldos y conciliación existentes; no se crean
pagos a partir de una declaración enviada por la web.

Decisión de alcance propuesta: las condiciones de pago pertenecen al acuerdo
comercial completo, no a cada programación. La base del porcentaje es su total
neto acordado en la moneda del documento, incluido traslado y otros artículos.
Si varios paquetes sugieren condiciones diferentes, hay que elegir y guardar
una condición común antes de cerrar la propuesta; nunca se suman porcentajes
ni se utiliza un cobro como anticipo independiente de varios eventos.

La cotización identifica explícitamente el inicio de la primera prestación como
fecha de referencia del acuerdo. Una contratación puede conservar múltiples
programaciones y fechas, pero el saldo común vence respecto de esa primera
prestación. No basta un anticipo de un paquete para confirmar otro: el umbral
se calcula sobre todo el acuerdo y los cobros efectivos asignados a él. Si el
negocio necesita pagos y confirmaciones independientes por evento, debe emitir
cotizaciones independientes. Este límite afecta únicamente a la nueva política
de pago relativo; no restringe las programaciones ya existentes de Agenda.

Se distinguen propuesta aceptada, anticipo pendiente, programación y evento
confirmado. Sin anticipo mínimo cobrado y aplicado, o sin programación completa,
el evento no aparece como confirmado. El saldo vencido genera un estado visible
y bloquea iniciar/completar el servicio hasta regularizarlo o registrar una
excepción autorizada con motivo. No cancela reservas ni mueve dinero por sí solo.
Si se cambia la fecha, se recalcula el vencimiento con la zona horaria del evento
y se conserva historial. No hay correos, cargos o devoluciones automáticos.

## API externa y seguridad

- Exponer paquetes publicados y variantes con un permiso nuevo de lectura.
  Las claves actuales no ganan permisos automáticamente. No publicar catálogos
  incompletos ni inventar precios para zonas o configuraciones pendientes.
- Extender la creación/edición de borradores para recibir selecciones de paquete,
  versión, opciones y cantidades. El servidor valida y calcula mediante la misma
  lógica de las pantallas internas. Sigue creando solamente borradores.
- Mantener separada la disponibilidad de stock de una consulta opcional de
  disponibilidad horaria, con permiso propio, rango temporal y límites acotados.
  Esta consulta devuelve ventanas disponibles, nunca nombres de empleados,
  agendas privadas, inventario de equipos o detalles de otras reservas.
- Una consulta de disponibilidad no bloquea ni programa nada. Las escrituras
  públicas no confirman ventas, pagos o contrataciones ni eluden la programación
  interna. Una API externa para reservar automáticamente queda fuera de alcance.
- No añadir CRUD público de productos, empleados o recursos para conectar una
  web de catálogo; se administran desde el ERP.
- Reutilizar aislamiento por empresa/sucursal, controles de acceso, límites,
  auditoría sin secretos, idempotencia y versiones. Referencias ajenas o privadas
  no pueden resolver datos de otra empresa ni filtrar su existencia.
- La key permanece en el servidor de la web; nunca en React, VITE_, el HTML
  público, un iframe de personalización ni el almacenamiento del navegador.
- Costos, ponderaciones internas, recetas privadas, salarios y directorios de
  personal no forman parte de las respuestas públicas.

## Orden de entrega

El trabajo comprende varios bloques conectados; no se declarará completo con
solo agregar campos o un catálogo sin uso comercial.

1. **Composición cotizable:** catálogo versionado de paquetes, variantes y
   elecciones; selección y cantidades dentro de cotizaciones, cálculo,
   conservación y validación en todos sus puntos de entrada y conversión.
2. **Operación:** requisitos e intervalos de recursos/servicios, traslado,
   condiciones de pago y estados de confirmación, sin duplicar stock o cobros.
3. **Integración:** catálogo publicable, selección mediante borradores API y
   consulta horaria acotada; documentación y ejemplos sin credenciales reales.

Los cambios de esquema serán aditivos y compatibles con registros que no usan
paquetes. Se verifican migraciones en una base temporal, incluyendo los guardas
de revisión y reservas actuales, antes de solicitar aplicación en la base activa.
No se ejecutarán migraciones destructivas, reinicios de datos ni cargas de
DonShot para demostrar funcionalidad.

## Comprobación requerida

- Cantidades enteras/decimales según unidad, elecciones duplicadas o no elegibles,
  sumas incompletas, límites de sabores, límites de tamaño y referencias ajenas.
- Aritmética exacta de precio cerrado, componentes gratuitos, residuo monetario,
  varias unidades, descuentos autorizados y compatibilidad fiscal existente.
- Borrador incompleto permitido pero no cerrable; versión de catálogo obsoleta;
  inmutabilidad después de aceptar; conversiones y operaciones parciales.
- Documentos antiguos sin paquete conservan sus flujos y cálculos actuales.
- Fabricación seguida de venta sin doble consumo y equipos sin baja de stock.
- Requisitos completos, conflictos concurrentes, intervalos de viaje/preparación,
  hitos sin solapamientos artificiales y cancelaciones sin liberaciones ajenas.
- Anticipo, pagos revertidos, saldo, excepciones, cambio de fecha y zona horaria.
- Varios paquetes y programaciones comparten una obligación global: no se
  duplican anticipos; políticas incompatibles requieren acuerdo explícito y el
  vencimiento usa el inicio más temprano. Reprogramar a una fecha anterior exige
  recalcular la referencia y revisar las confirmaciones en la misma operación.
- API sin precios libres, permisos nuevos opt-in, consultas limitadas y ausencia
  de costos/identidades privadas; reintentos y versiones no duplican documentos.
- Pantallas accesibles y compactas, mensajes con acciones claras, composición
  visible en la propuesta compartida y continuidad hasta pedido/contratación/venta.

## Delegado al plan de implementación

Elegir nombres concretos de tablas, DTO y archivos; rutas siguiendo los módulos
existentes; índices y relaciones compuestas según sus consultas; límites
razonables de opciones y componentes; mecanismo exacto de reparto monetario;
disposición visual usando los componentes del sistema. Estas elecciones deben
respetar las invariantes anteriores y quedar cubiertas por pruebas.

No se presupone que los datos reales de DonShot estén ya cargados en Auna ni
que Agenda y servicios estén habilitados en su empresa.
