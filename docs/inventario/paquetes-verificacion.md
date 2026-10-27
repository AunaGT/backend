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
| Suite completa del servidor, después de correcciones | 1,636/1,636 |
| Suite completa de interfaz, después de correcciones | 1,474/1,474 |
| Regresiones de módulos del servidor | 97/97 |
| Fronteras físicas de módulos de interfaz | 23 módulos, sin infracciones |
| Comprobación TypeScript | Sin errores |
| Compilación Vite | Correcta; avisos existentes de tamaño y Browserslist |
| Migración PostgreSQL en base vacía desechable | Correcta; conserva documentos, claves y recibos anteriores |
| Aceptación y concurrencia PostgreSQL | 2/2; incluye revalidación de Agenda y su venta borrador |
| Parciales, devoluciones y producción con servicios reales y persistencia controlada | Correctos |
| Catálogo en 375/768/1440 px, claro/oscuro | Sin desbordamiento; conserva sidebar y foco |
| Propuesta agrupada en 375/1440 px | Inspeccionada, con condiciones de servicio visibles |
| PDF de cotización y pedido | Texto/importes correctos; páginas renderizadas e inspeccionadas |

La primera suite final del servidor tuvo una falla intermitente anterior en
`exportPdf.test.js`, «tarjetas de productos conservan descripción, mayoreo y
promoción al paginar»: faltó el pie de la primera página. Su repetición aislada
pasó 6/6 y la repetición completa pasó 1,636/1,636. No se cambió el exportador
ajeno al alcance para ocultarla; sigue siendo un riesgo de esa prueba/exportación.

Poppler mostró glifos incorrectos incluso en un PDF mínimo independiente.
Ghostscript renderizó correctamente ambos documentos; no se modificaron fuentes
de la aplicación por un problema del renderizador local.

## Revisión y pendientes

Una revisión independiente parcial encontró tres problemas importantes, todos
reproducidos primero con pruebas fallidas y corregidos:

1. Agenda redondeaba Q7.995 a Q8.00 al cargar componentes con unidades antiguas.
   Ahora conserva su precisión; la contratación persistida se valida contra la
   cotización y su venta borrador conserva Q7.995.
2. Una venta parcial en unidad base podía mostrar la etiqueta de la presentación
   original. Ahora muestra la cantidad y unidad realmente facturadas.
3. Agrupar partidas ocultaba las condiciones públicas de los servicios.
   Ahora se conservan visibles y su proyección pública excluye campos privados.

La herramienta del revisor alcanzó su límite antes del dictamen completo.
La comprobación restante fue local, por el autor: **no existe un dictamen
independiente completo ni se declara listo para producción o fusión**.
La evidencia de trabajo se conserva para retomar ese cierre sin repetir tareas.

Detalle menor diferido: una venta formada solo por paquetes aún conserva el
encabezado de la tabla existente junto a su pie financiero, aunque los componentes
y sus importes se muestran correctamente en el resumen agrupado.

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
- Se corrigieron los tres hallazgos recibidos y se retuvo el cierre de revisión
  independiente como pendiente por su interrupción. Riesgo: el autor no sustituye
  una segunda mirada completa; no se declaró listo para producción/fusión.

## Continuación solo Auna

El tramo 2a se implementó después de esta verificación del bloque 1; su evidencia
y estado de migración están en [Requisitos de servicios](requisitos-servicios-verificacion.md).
Los hitos/traslado y anticipos siguen en tramos posteriores. La integración con
DonShot permanece pendiente por decisión del usuario.
