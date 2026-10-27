# Verificación de paquetes comerciales — 26 de octubre de 2026

## Resultado funcional

Implementación local del bloque 1: catálogo versionado de paquetes, composición
acordada en la cotización, borradores incompletos, edición con revisión, conversión
a pedido/venta borrador/Agenda y presentación compartida/PDF/API de documentos
propios. Guía: [Paquetes comerciales](paquetes-comerciales.md).

Rutas: `/inventario/paquetes`, `/inventario/paquetes/nuevo`,
`/inventario/paquetes/:id/editar`, `/cotizaciones/nueva`,
`/cotizaciones/:id/editar`.

No se conectó DonShot ni se llamaron endpoints de Infile. Las comprobaciones de
negocio usaron persistencia sintética, no ventas o credenciales de clientes reales.
La migración aditiva de localhost se había aplicado con autorización específica;
no se repitió en esta verificación.

## Evidencia final

| Comprobación | Resultado |
| --- | --- |
| Suite completa del servidor, después de correcciones | 1,639/1,639 |
| Suite completa de interfaz, después de correcciones | 1,478/1,478 (`tests/*.test.*`, no solo CJS) |
| Regresiones de módulos del servidor | 97/97 |
| Fronteras físicas de módulos de interfaz | 23 módulos, sin infracciones |
| Comprobación TypeScript | Sin errores |
| Compilación Vite | Correcta; avisos existentes de tamaño y Browserslist |
| Migración PostgreSQL en base vacía desechable | Correcta; conserva documentos, claves y recibos anteriores |
| Aceptación y concurrencia PostgreSQL | 2/2; incluye revalidación de Agenda, venta borrador y conflictos de moneda sin alterar el acuerdo |
| Parciales, devoluciones y producción con servicios reales y persistencia controlada | Correctos |
| Catálogo en 375/768/1440 px, claro/oscuro | Sin desbordamiento; conserva sidebar y foco |
| Propuesta agrupada en 375/1440 px | Inspeccionada, con condiciones de servicio visibles |
| PDF de cotización y pedido | Texto/importes correctos; páginas renderizadas e inspeccionadas |

Se resolvió la falla intermitente de `exportPdf.test.js`: el lector de la prueba
quitaba un byte binario `0x0d` del checksum comprimido al confundirlo con parte del
delimitador. Se reprodujo con la hora original y la secuencia previa de pruebas;
restaurar ese byte permitió descomprimir la página completa, con su pie intacto.
La regresión determinista falló primero y pasó después de respetar los delimitadores
LF de PDFKit. Exportación 7/7 y suite completa 1,639/1,639. No se modificó el
exportador ni se relajó la comprobación del pie.

Poppler mostró glifos incorrectos incluso en un PDF mínimo independiente.
Ghostscript renderizó correctamente ambos documentos; no se modificaron fuentes
de la aplicación por un problema del renderizador local.

## Revisión y pendientes

La revisión independiente, inicialmente interrumpida y ahora completada, encontró tres problemas importantes, todos
reproducidos primero con pruebas fallidas y corregidos:

1. Agenda redondeaba Q7.995 a Q8.00 al cargar componentes con unidades antiguas.
   Ahora conserva su precisión; la contratación persistida se valida contra la
   cotización y su venta borrador conserva Q7.995.
2. Una venta parcial en unidad base podía mostrar la etiqueta de la presentación
   original. Ahora muestra la cantidad y unidad realmente facturadas.
3. Agrupar partidas ocultaba las condiciones públicas de los servicios.
   Ahora se conservan visibles y su proyección pública excluye campos privados.

El mismo revisor retomó y completó el alcance restante. Dictamen recibido:
«Ready to merge: With fixes», sin Critical, con dos Important adicionales y un
Minor. Se reprodujeron y corrigieron con pruebas RED→GREEN:

4. Cambiar la moneda de empresa permitía cotizar una versión de paquete en otra
   moneda. Ahora se rechaza al seleccionar/editar/previsualizar y antes de
   enviar/aceptar/compartir/convertir, confirmar pedidos, facturar parciales o
   preparar/confirmar su venta de Agenda. No hay conversión automática. Las
   propuestas históricas, sus páginas públicas y PDF conservan la moneda del grupo.
5. Elegir otra sucursal autorizada en cotización fallaba por comparar el destino
   con la sucursal global activa. Ahora el scope distingue ambos: envía el destino,
   pero descarta respuestas si cambia el contexto global, la empresa o la sesión.
6. El editor de un borrador incompleto mostraba un total final cero. Ahora usa el
   estado pendiente del resumen existente.

También se corrigió el encabezado/tabla vacía en ventas formadas solo por paquetes,
sin ocultar totales financieros ni el estado de una venta realmente vacía. Ventas
mixtas cuentan solamente los artículos libres en su tabla.

Los fixes posteriores al dictamen se verificaron localmente, no mediante una
segunda revisión independiente. No se hizo despliegue a producción ni fusión;
los cambios mixtos previos se mantienen intactos y necesitan separación al integrar.

Los bloques 2 y 3 continúan fuera de esta entrega: requisitos avanzados de
recursos/traslados/anticipos y nuevas capacidades externas de paquetes/horarios.

## Decisiones de implementación y costo si fueran incorrectas

- Se trabajó en los repositorios locales existentes, no en otro checkout, porque
  dependen de cambios previos sin confirmar. Riesgo: los cambios mixtos deben
  revisarse y separarse antes de fusionar; no se resetearon ni confirmaron en bloque.
- La validación compartida de productos/unidades vive en `packages/references.js`.
  Costo: se puede reunir de nuevo sin cambiar el contrato si resultara innecesaria.
- La aplicación de la migración se pidió antes de regenerar el cliente activo.
  Costo: un punto de aprobación adicional, evitando lecturas contra columnas ausentes.
- La prueba de migración genera clientes antiguos/nuevos solo en directorios
  desechables. Costo: más tiempo de prueba; no sustituye el cliente de la aplicación.
- La proyección pública omite selección técnica y snapshots/revisiones de unidades.
  Costo: el editor debe conservar su selección propia, no reconstruirla de datos públicos.
- La validación de ventas estuvo cerrada hasta integrar sus conversiones y pruebas.
  Costo temporal: esa ruta no estuvo utilizable durante la implementación; ya fue integrada.
- Los snapshots de unidades antiguas se propagan solo en componentes confiables
  cargados por el servidor. Riesgo: aceptar esa identidad desde entradas libres
  rompería el aislamiento; las entradas de navegador/API la rechazan con pruebas.
- El pedido conserva bruto y descuento del acuerdo; la distribución neta incluye
  unidades antiguas de paquetes. Costo: una inconsistencia rechaza la operación
  para revisión en vez de recalcular silenciosamente.
- La comparación de origen normaliza nombres de campos de documentos/ventas y
  orden de claves JSON; los parciales se verifican contra asignaciones netas y
  saldos bloqueados. Riesgo: una variante no contemplada debe fallar de forma cerrada.
- El editor de paquetes tiene ancho acotado, sin la regla de ancho fluido global.
  Costo: algo más de espacio lateral en pantallas grandes, sin inputs gigantes.
- Editar conserva el descuento anterior. Costo: si al quitar partidas el descuento
  supera el subtotal, exige revisión en lugar de eliminarlo automáticamente.
- Los artículos libres guardados se identifican por una partida propia bloqueada
  y conservan precio/condiciones. Costo: referencias ajenas o malformadas se rechazan.
- Las etiquetas de productos se cargan solo para la variante seleccionada, de seis
  en seis; búsqueda/paginación se cancelan al cambiar de alcance. Costo: las
  etiquetas pueden aparecer progresivamente; nunca determinan el precio financiero.
- El PDF anota grupo/variante en cada partida real, sin agregar otra fila de cobro.
  Costo: repite el nombre del grupo; los pedidos mantienen sus contadores de entrega.
- La aceptación PostgreSQL cubre persistencia, revisión, reintentos, rollback y
  rutas comerciales. La operación física parcial/producción se verifica por
  separado con los servicios reales. Límite: no es un único recorrido físico
  completo con PostgreSQL; se documenta, no se presenta como tal.
- El revisor original completó el dictamen; se corrigieron sus cinco Important y
  su Minor con regresiones. Las correcciones finales no recibieron otra revisión
  independiente: no se presenta la verificación del autor como una segunda mirada.
- La moneda congelada manda en la presentación del acuerdo; operar exige coincidir
  con la configuración actual. Costo: para continuar un acuerdo de otra moneda hay
  que revisar la configuración o crear uno nuevo, no hay cambio de divisas implícito.

## Continuación solo Auna

El tramo 2a se implementó después de esta verificación del bloque 1; su evidencia
y estado de migración están en [Requisitos de servicios](requisitos-servicios-verificacion.md).
Los hitos/traslado y anticipos siguen en tramos posteriores. La integración con
DonShot permanece pendiente por decisión del usuario.
