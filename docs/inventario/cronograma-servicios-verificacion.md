# Cronograma de servicios — verificación 2b.1

Alcance: momentos del evento, horarios propios de personal/equipo, cobertura
temporal de requisitos y conservación de reglas/recibos/versiones de Agenda.
No se aplicó la migración ni se regeneró el cliente de la aplicación. No se
hicieron llamadas a Infile, DonShot ni servidores externos.

## Garantías verificadas

- Proyección compartida por identidad. La envolvente de una actividad se usa para
  preseleccionar registros, no para bloquear a todos sus participantes por igual.
- El responsable sigue completo; invitados no reservan. Profesionales vinculados
  a usuarios/empleados, equipos, calendarios y ausencias usan su intervalo real.
- Un requisito completo no admite cobertura corta. Una intervención debe cubrir
  simultáneamente todo el momento para todas sus plazas, sin contar dos veces a
  la misma persona o equipo.
- Omitir cronograma desde un editor anterior conserva el guardado. Mover conserva
  offsets; acortar fuera de límites falla. Vaciar explícitamente revalida los
  requisitos. No cambia cantidades, precios, stock ni pagos.
- La transacción existente guarda asignaciones, cronograma, historial, versiones
  y recibo conjuntamente. No se agregó un almacén de reservas paralelo.
- El resumen público de condiciones admite solo el modo/nombre/tipo/cantidad;
  no recibe cronograma, opciones privadas, identidades ni recursos operativos.

## Evidencia automatizada

- Backend completo: **1701/1701**. Módulos backend: **97/97**.
- Pruebas de interfaz Agenda/requisitos/cronograma: **17/17**. Tipos TypeScript y
  compilación de producción correctos; **23 módulos** respetan sus fronteras.
- PostgreSQL: migración **1/1**, aceptación concurrente **9/9**, regresión de la
  migración 2a **1/1** y concurrencia 2a **6/6**. El primer intento de aceptación
  tenía una consulta de fixture a `Sale.company_id`, que no existe; se corrigió
  a la sucursal y se repitió sin modificar código productivo para ese caso.
- Interfaz hidratada con datos ficticios: **6 casos**, 375/768/1440 px y claro/
  oscuro. Comprueba agregar sin perder momentos, foco en el nombre, revisión
  explícita de márgenes, solo lectura y ausencia de desbordamiento horizontal.
  La inspección de la imagen móvil detectó fechas recortadas: los controles ahora
  se acomodan en otra línea cuando no caben, conservando legibilidad.
- Suite completa frontend: **1508/1508** con concurrencia2. Un primer intento con
  concurrencia4 encontró un fallo de tiempo en autocompletado de cupones ajeno al
  bloque; su prueba aislada pasó4/4 y se repitió la suite con concurrencia2.

Los tests PostgreSQL solo aceptan URLs explícitas en loopback y bases con prefijo
`auna_timeline_test_*` o, para 2a, `auna_requirements_test_*`. Generan clientes en
directorios temporales, nunca en `node_modules` de la aplicación. Los escenarios
usan empresas y personas ficticias y dos conexiones independientes.

## Despliegue y límites

La migración aditiva agrega JSONB versionado con default vacío y límites de forma,
cantidad y tamaño; el servidor valida contenido cerrado, referencias y duración.
El orden autorizado será migración → generación del cliente → reinicio del backend.
La capacidad del directorio impide habilitar los controles nuevos con un cliente
antiguo. No se debe generar el cliente antes de aplicar la migración.

La aceptación cubre competencia por el mismo profesional, intervenciones
disjuntas con eventos solapados, equipo completo, alias usuario/profesional,
reprogramación y acortamiento, consultas y reservas individuales, ausencia por
empleado vinculado, rollback del segundo programa y reintento del recibo.

Pendientes fuera de este bloque: 2b.2 (zonas y cargos monetarios de traslado),
2c (políticas de anticipo/confirmación), catálogo/disponibilidad pública y DonShot.

## Revisión independiente y decisiones

La revisión independiente encontró dos regresiones importantes, reproducidas
primero en pruebas que fallaban y corregidas en una sola pasada:

1. Vincular un profesional con reservas antiguas a un usuario ocupado podía
   ignorar su identidad en el intervalo legado. El fallback conserva ahora su
   identidad canónica y todo el horario. Se cubren actividades y reservas de servicio.
2. Asignar a un usuario sin seleccionar también su ficha de profesional podía
   omitir el calendario vinculado. La proyección expande los alias por bloque,
   comprobando su horario completo o propio, nunca el de otra persona.

Se repitieron las suites backend, módulos y aceptación PostgreSQL después de las
correcciones. La interfaz no cambió durante esa pasada. No quedaron hallazgos
críticos, importantes ni menores pendientes de esa revisión.

Decisiones de ejecución y su límite:

- El archivo original del plan estaba vacío: se conservó y se recuperó el alcance
  aprobado en otro archivo. Coste: existe un documento adicional de ejecución.
- Se continuó en los checkouts con requisitos anteriores sin confirmar, separando
  los cambios propios. Coste: los cambios anteriores y la pequeña compatibilidad
  añadida en archivos de integración ya no rastreados deben preservarse si más
  adelante se prepara una publicación; no se incorporaron esos archivos completos.
- Se dejó la capacidad nueva bloqueada hasta desplegar migración y cliente en
  ese orden. Coste: no se puede usar todavía contra el cliente activo anterior.
- La reversión entre varios programas se comprobó en PostgreSQL en la aceptación
  final, no con una transacción simulada en la tarea de guardado. Coste: la prueba
  unitaria de esa tarea, por sí sola, no acredita atomicidad de base de datos.
- La aceptación integrada comprobó piezas ya implementadas, sin fabricar un
  fallo previo artificial. Las pruebas de dominio y regresiones sí tuvieron
  evidencia de fallo y posterior aprobación. Coste: los escenarios completos
  no sustituyen esa evidencia unitaria.
- Se repitió la suite frontend con concurrencia2 por el fallo temporal de cupones
  bajo carga4. Coste: verificación más lenta; no se modificó ese comportamiento ajeno.

Aspectos que la revisión dejó deliberadamente fuera de su comprobación directa:

- El despliegue activo sigue pendiente; solo se verificó la guarda y se confirmó
  localmente que el cliente activo no contiene el nuevo campo. No se conectó a la
  base de la aplicación. Coste: su despliegue requiere una verificación posterior.
- El revisor inspeccionó las fuentes y evidencia, y reprodujo ambos defectos con
  dobles de prueba; no repitió todas las suites. El ejecutor sí las corrió. Coste:
  los resultados completos no tienen una segunda ejecución independiente.
- Cada identidad sigue contando una sola vez por programación, incluso en roles
  separados no simultáneos, conforme a 2a. Coste: no se reutiliza una persona para
  cubrir dos requisitos distintos de la misma programación.
- La pista de cobertura del navegador puede ser conservadora si los permisos
  ocultan vínculos personales. La decisión del servidor es la autoridad. Coste:
  el contador puede mostrar menos cobertura que la finalmente aceptada.
- No se revisaron cambios previos ajenos ni se agregaron cargos, anticipos o
  integración pública. Coste: estas capacidades siguen siendo bloques separados.
