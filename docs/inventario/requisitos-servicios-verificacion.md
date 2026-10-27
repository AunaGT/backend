# Verificación de requisitos de servicios — bloque 2a

## Alcance

Solo Auna. Requisitos versionados de personal y equipo en el perfil del servicio,
emparejamiento por identidad, cobertura por sucursal/lugar, validación transaccional
al reservar y condiciones públicas congeladas en cotizaciones. Reutiliza Agenda;
no añade inventario, pagos, hitos ni conexiones con DonShot o Infile.

Guía: [Paquetes y requisitos](paquetes-comerciales.md).
Plan aprobado recuperado: [Ejecución 2a](../superpowers/plans/2026-10-26-requisitos-servicios-bloque-2a-ejecucion.md).
El archivo original del plan fue editado por el usuario y se conservó intacto.

## Comprobaciones

- Backend completo: 1,664/1,664; módulos: 97/97.
- Frontend completo final: 1,486/1,486; TypeScript sin errores y compilación Vite correcta.
  Permanecen avisos anteriores de Browserslist, bundles grandes y SSR en pruebas.
- Esquema Prisma válido con URL sintética. Tras autorizar el despliegue se
  regeneró el cliente activo y se comprobó una lectura tipada del nuevo campo.
- Migración en PostgreSQL temporal: 1/1, conserva perfiles, políticas, asignaciones,
  documentos y recibos, comprueba límites del JSON y rollback.
- Aceptación PostgreSQL: 6/6, dos contrataciones compiten por equipo y solo una
  guarda; reintento con un solo efecto; fallo en la segunda selección revierte
  sesiones, historial y recibo; citas, trabajos y clases exigen todos los equipos;
  búsqueda, inscripción y reprogramación conservan requisitos originales incluso
  cuando las opciones dejan el perfil actual; las ausencias vinculadas mediante
  usuario bloquean consulta y reserva.
- Interfaz con componentes reales hidratados y datos sintéticos: 375/768/1440 px
  en claro/oscuro sin desbordamiento horizontal; sidebar/foco/etiquetas presentes;
  cobertura de selección cambia de 1/2 a 2/2; edición deshabilitada en solo lectura.
  Es una página aislada, no una sesión autenticada de la aplicación.

La prueba de aceptación encontró que el select interno de sesiones omitía su
política congelada. Se reprodujo con PostgreSQL y se corrigió antes de repetir
la suite completa. Los clientes antiguos/nuevos de migración se generan solo en
directorios temporales; la aceptación comparte un mismo runtime Decimal con sus
comandos. Las URL de prueba rechazan bases no aisladas.

Reproducción: `npm test`, `npm run test:modules`, y los archivos
`tests/appointments.requirements*.test.js`. Las pruebas PostgreSQL
`appointments.requirements-migration.pg.e2e.js` y
`appointments.requirements-concurrent.e2e.js` requieren URL explícita
`APPOINTMENTS_REQUIREMENTS_TEST_DATABASE_URL` de una base local desechable
`auna_requirements_test_*`. La migración exige base vacía; concurrencia usa esa
base ya migrada. No deben usar la base de la aplicación.

En frontend: `node --test tests/*.test.*`, `npx tsc --noEmit`, `npm run build`.
`node tests/visual/requirements-preview.cjs` genera el ensayo interactivo aislado
en `output/playwright`; no hace peticiones de negocio ni necesita credenciales.

## Despliegue y revisión

La migración `20261027120000_service_assignment_requirements` fue **aplicada a la
base que utiliza localhost con autorización explícita**. Antes de desplegar se
comprobó que era la única migración pendiente y que las conexiones de aplicación
y migración apuntaban a la misma base. No se aplicaron cambios ajenos al bloque.

Las huellas de contenido y cantidades de 21 tablas permanecieron iguales antes
y después, incluyendo perfiles, asignaciones, reservas, contrataciones, documentos,
ventas, claves y recibos de integración. Los 73 perfiles existentes iniciaron con
requisitos vacíos; la nueva columna es JSONB no nula con valor predeterminado `[]`.
El estado posterior de Prisma confirmó todas las migraciones aplicadas.

Se regeneró el cliente activo y una consulta tipada leyó el campo correctamente.
Se reinició únicamente el backend local mediante su supervisor existente; se
comprobó un proceso nuevo y `/health` respondió HTTP 200 con conexión a la base.
No se crearon ventas ni reservas para probar este despliegue, no se enviaron
facturas y no se contactaron certificadores o DonShot. La aceptación funcional
autenticada mediante navegador no forma parte de esta comprobación de despliegue.

La revisión independiente encontró dos problemas importantes y uno inicialmente
menor. Los tres se reprodujeron con pruebas fallidas y se corrigieron en una sola
pasada:

1. Las clases antiguas perdían sus candidatos si se quitaban del perfil actual.
   Se cargan sus asignaciones activas/calendarios por separado, sin habilitarlas
   para sesiones nuevas. La prueba PostgreSQL reemplaza todas las opciones del
   perfil y comprueba búsqueda, inscripción y reprogramación de la clase anterior.
2. La disponibilidad omitía ausencias de empleados vinculados al profesional por
   su usuario. Ahora conserva el mapa de identidad ya resuelto y consulta esas
   ausencias. PostgreSQL verifica que no ofrece horario ni guarda una reserva.
3. Cambiar de lugar ocultaba una selección incompatible y seguía contando su
   cobertura. Se trató como importante porque impedía corregirla desde el contexto
   actual. El selector compartido conserva el borrador, avisa y permite quitarla;
   la cobertura excluye opciones incompatibles, archivadas o ya no habilitadas.

Las correcciones se verifican con regresiones y suites completas; no se pidió una
segunda revisión independiente. No quedaron hallazgos menores diferidos de 2a.

Se observó una falla previa intermitente en `coupon-code-completion.test.cjs`,
«shape style suggestions respect tipo, including a type after style»: la ejecución
completa con concurrencia predeterminada obtuvo 1,485/1,486 por una sugerencia nula.
El archivo pasó 4/4 aislado y la repetición de **todos** los tests con
`--test-concurrency=4` pasó 1,486/1,486. No se modificaron el editor de cupones ni
sus pruebas, no se omitieron casos ni se relajaron aserciones; no se presenta esa
intermitencia como corregida por este bloque.

## Decisiones y límites

- Se continuó en los checkouts existentes por dependencias previas sin confirmar.
  Costo: separar los cambios mixtos al integrar; no se resetearon ni agruparon.
- Se recuperó el plan en otro archivo para conservar la edición del usuario.
  Costo: una segunda ruta de plan, enlazada explícitamente.
- La identidad se valida ya al configurar el servicio, incluida la referencia
  usuario/empleado necesaria aunque la interfaz de RR. HH. no esté habilitada.
  Costo: lectura mínima privada adicional, nunca datos de nómina o salida pública.
- Solo una selección totalmente vacía puede pedir una propuesta automática de
  ese tipo; la selección parcial no se completa silenciosamente. Costo: hay que
  quitar la selección parcial si se quiere otra propuesta automática.
- Una clase existente conserva su política. Costo: la consulta interna carga
  ese JSON privado; no se entrega a páginas públicas.
- La API existente acepta solo el nuevo resumen público acotado al editar un
  borrador de servicio. Costo: otro campo validado, no una nueva capacidad API.
- Se extrajo y reexportó el selector de asignaciones ya existente para evitar
  importación circular. Costo: un archivo compartido pequeño, sin dependencia.
- La cobertura visual es preliminar: la identidad y disponibilidad finales son
  del servidor. Costo: una opción que parece suficiente puede ser rechazada al
  guardar si sus referencias privadas o el calendario no cumplen.
- La búsqueda de la guía de diseño no produjo una coincidencia específica útil;
  se aplicaron sus reglas generales y controles de Auna. Costo: validación visual
  local, no un patrón específico propuesto por esa búsqueda.
- Para las clases existentes se cargan asignaciones activas históricas aparte
  del catálogo actual. Costo: una consulta adicional acotada por período para
  servicios de clase; no habilita esas opciones al crear una sesión nueva.
- La revisión se realizó antes de autorizar el despliegue, posteriormente aplicado
  y verificado por separado. Costo: el ensayo interactivo y la comprobación de
  salud no sustituyen una aceptación funcional autenticada en navegador.
- La revisión excluyó cambios mixtos ajenos, incluido el helper de moneda anterior.
  Costo: se conservan, pero esta revisión no certifica esos otros cambios.

Los siguientes tramos son 2b (hitos/intervalos/traslado) y 2c (anticipos y
condiciones globales de confirmación). DonShot y la API externa de paquetes
siguen pendientes por decisión del usuario.
