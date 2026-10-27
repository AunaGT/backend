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

- Backend completo: **1698/1698**. Módulos backend: **97/97**.
- Pruebas de interfaz Agenda/requisitos/cronograma: **17/17**. Tipos TypeScript y
  compilación de producción correctos; **23 módulos** respetan sus fronteras.
- PostgreSQL: migración **1/1**, aceptación concurrente **8/8**, regresión de la
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
