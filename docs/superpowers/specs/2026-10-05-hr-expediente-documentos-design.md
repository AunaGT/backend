# RRHH: fidelidad visual y expediente documental configurable

Estado: diseño para revisión, todavía no implementado.

## Objetivo y acuerdos

Rehacer el listado, alta y expediente de empleados siguiendo las seis referencias proporcionadas por el usuario. La implementación anterior reutilizó componentes, pero alteró demasiado la composición y omitió documentos y resumen operativo. Se conserva el marco de navegación global del ERP; dentro del módulo se reproducen distribución, jerarquía, densidad, colores y estados de las referencias en claro y oscuro.

El usuario confirmó que el bucket existente se llama `hr`, que los documentos dependen de las preferencias de cada empresa y que su acceso debe ser privado mediante enlaces temporales. No se crearán requisitos mexicanos fijos ni indicadores ficticios.

## Referencias y composición

- `auna-erp-redesign/dark/hr/01-employees-dark.png` y su equivalente en `light/hr`: título Empleados y botón de alta en la misma cabecera; cuatro indicadores horizontales con iconos; filtros visibles; tabla compacta con foto, nombre, código y correo juntos; puesto, sucursal, estado, ingreso y acciones; paginación y tamaño de página.
- `auna-erp-redesign/missing-views/{dark,light}/09-employee-create-*.png`: columna principal con dos tarjetas independientes —Datos personales y Puesto y condiciones—; columna derecha de Documentos; acciones finales alineadas a la derecha. La fotografía no sustituye al panel documental.
- `auna-erp-redesign/missing-views/{dark,light}/10-employee-detail-*.png`: fotografía grande en la cabecera, nombre, estado y contexto laboral; pestañas con iconos y subrayado naranja; tarjetas de datos personales, datos laborales y resumen rápido; debajo, asistencia reciente, anticipos e historial. Edición desde las tarjetas y cabecera.

Reutilizar Table, Pagination, botones, controles y diálogos Auna existentes. Las pestañas subrayadas se apoyarán en las primitivas accesibles existentes, no en el estilo segmentado que contradice esta referencia. CSS acotado a RRHH, sin modificar pantallas de otros módulos.

## Datos y límites funcionales

Conservar DPI, NIT, IGSS, bonificación incentivo, frecuencia y forma de pago. Los identificadores mexicanos se reemplazan por los datos locales ya soportados. No dividir ni reinterpretar automáticamente los nombres existentes.

Agregar datos opcionales necesarios para las referencias: género, estado civil, nacionalidad, jornada, descripción de horario y supervisor. Sin valores obligatorios universales ni efectos nuevos en el cálculo salarial. Supervisor debe pertenecer a la misma empresa, no puede ser el propio empleado y debe respetar el acceso del usuario.

“En licencia” no significa “Suspendido”: el indicador se calcula a partir de VACACIONES, INCAPACIDAD o PERMISO vigentes en la asistencia del día. Activos, licencia e inactivos deben tener una definición consistente y evitar contar a una persona dos veces. Suspensión y baja mantienen su significado actual. No mostrar comparaciones mensuales hasta poder calcularlas con historial suficiente; mostrar disponibilidad real, no porcentajes inventados.

Listado con búsqueda y filtros de estado, puesto y sucursal; consulta paginada en servidor, orden estable con desempate por ID, tamaños 8/16/32 y reinicio de página al cambiar filtros. El filtro de sucursal solo ofrece las sucursales autorizadas; nunca amplía el alcance del usuario.

## Configuración documental por empresa

Agregar una sección “Expedientes de empleados” en Configuración, administrada con `settings.manage`. Cada tipo de documento tiene ID estable, nombre, instrucciones, obligatorio/opcional, activo/inactivo y orden. Límite inicial: PDF, JPEG y PNG, hasta 5 MB por archivo, validado en servidor.

Las empresas empiezan sin requisitos obligatorios. Pueden configurar identificación, constancias u otros documentos según sus necesidades. Renombrar un tipo no rompe sus documentos. Desactivarlo evita nuevas solicitudes pero conserva los archivos históricos. Cambiar obligatoriedad recalcula la integridad documental del expediente, sin suspender al empleado ni alterar nómina.

Modelos:

- `EmployeeDocumentType`: empresa, nombre, instrucciones, obligatoriedad, actividad y orden; marcas de creación/actualización.
- `EmployeeDocument`: empresa, empleado, tipo, ruta privada, nombre original, MIME, bytes, usuario que subió, fecha y estado archivado. Un archivo vigente por tipo y empleado; los reemplazos conservan la versión anterior archivada.
- `EmployeeHistory`: empresa, empleado, autor, evento, fecha y cambios estructurados mínimos. No guardar contraseñas, enlaces firmados ni contenido de los archivos en el historial.

Usar migraciones aditivas. Preservar empleados, fotografías y anticipos existentes. No inventar historial previo: identificar los registros antiguos como información anterior al inicio de la auditoría.

## Carga y conservación

Al crear, seleccionar archivos en el panel derecho y mostrar estados reales: pendiente, seleccionado, subiendo, cargado o error. Permitir cambiar o retirar una selección antes de guardar. Validar requisitos y archivos antes de crear el expediente.

Para un alta con documentos, recibir datos y archivos en una operación multipart; mantener compatible el alta JSON existente para empresas sin requisitos documentales. Validar primero los permisos, datos, requisitos activos y firmas de archivos. Subir los objetos a rutas nuevas fuera de la transacción de Prisma; después registrar empleado, metadatos e historial en una transacción corta. Si falla la base de datos, limpiar únicamente los objetos nuevos de esta operación. Usar un identificador de operación para que reintentos tras un fallo de red no dupliquen empleados.

En empleados existentes, permitir subir y reemplazar documentos individualmente. No borrar el archivo anterior antes de confirmar el nuevo registro. Archivar documentos es recuperable; no ofrecer purga permanente en esta entrega. Un fallo debe dejar visible qué se guardó y qué debe reintentarse.

La integridad documental se muestra como “Completo” o “Pendiente de documentos”, independiente del estado laboral. No impide editar ni dar de baja un expediente antiguo incompleto. El alta nueva exige los requisitos configurados cuando los haya.

## Bucket `hr` y seguridad

Rutas generadas por el servidor: `<company-id>/employees/<employee-id>/<random-id>.<extension>`. Nunca usar el nombre original para construir una ruta ni aceptar rutas arbitrarias del navegador.

Verificar que `hr` existe y es privado antes de habilitar la carga. No modificar silenciosamente su política ni publicar el bucket. Si no cumple, informar la condición concreta y bloquear la carga insegura.

Claves de almacenamiento solo en el backend. Ver y descargar requieren autenticar al usuario y verificar empresa, empleado, sucursal y permiso en cada petición; luego emitir un enlace firmado de corta duración. No persistir enlaces firmados en la base de datos ni incluirlos en registros de auditoría. El frontend renovará enlaces al volver a consultar y no almacenará respuestas privadas en cachés públicas.

Mantener lectura de fotografías anteriores; nuevas fotografías usarán `hr` con ruta privada y URL temporal. No ejecutar una migración masiva de objetos existentes sin una operación separada y verificable.

Permisos documentales nuevos: ver, gestionar y archivar documentos, separados de editar datos laborales. Administrar requisitos corresponde a `settings.manage`. No conceder nuevos permisos a todos los usuarios; incorporarlos al catálogo y al rol administrador según el patrón existente del sistema.

## Expediente e historial reales

Resumen rápido: asistencia del mes con numerador y denominador explícitos sobre marcas registradas —no porcentaje de jornada programada si no existe calendario—; número y saldo de anticipos pendientes; movimientos recientes auditados; estado laboral e integridad documental.

Las tarjetas inferiores muestran datos reales de asistencia, anticipos e historial, con estados vacíos y enlaces a sus pestañas. Historial se registra desde las mutaciones de datos laborales, baja y documentos, dentro de sus transacciones cuando corresponda. Los campos sensibles se muestran solo con los permisos aplicables.

“Descargar ficha” genera un documento con los datos visibles/autorizados del expediente. “Enviar mensaje” abre el correo del usuario si existe; no crea un sistema de mensajería ni envía nada automáticamente. Sin correo, explicar por qué no está disponible.

Los selectores de empleados/supervisores deben buscar en servidor con páginas pequeñas. La hoja de asistencia y el selector de anticipos no deben depender de obtener un expediente completo: usar una proyección mínima autorizada por el permiso de la operación, evitando exponer salario, identificación o documentos a quien solo gestiona asistencia.

## Verificación y aceptación

1. Comparar listado, alta y detalle con las referencias en claro y oscuro, a 1536 px, portátil y móvil. Guardar capturas; comprobar que no hay desbordamiento horizontal de página ni fondos cortados.
2. Probar filtros, paginación, selección y acciones; estados de carga/error y ausencia de datos.
3. Probar configuración independiente en dos empresas; obligatoriedad, renombrado y desactivación sin pérdida histórica.
4. Probar PDF/JPEG/PNG válidos, archivo vacío, tipo falsificado, tamaño excedido, fallo de storage, fallo de base de datos y reintento del alta.
5. Probar acceso cruzado por empresa/sucursal y usuarios sin permiso documental; expiración de enlaces y ausencia de URLs públicas nuevas.
6. Probar edición, historial y reemplazo/archivo conservando versiones; no alterar IGSS, asistencia ni contabilización de anticipos.
7. Ejecutar pruebas del backend, controles de módulos, lint, compilación y revisión de tipos de los archivos modificados. Separar claramente los errores generales preexistentes.

No dar por terminada la entrega solo por compilar: debe verificarse la persistencia, descarga autorizada y fidelidad visual.

## Fuera de alcance

No rehacer la navegación de todo el ERP, ni agregar organigrama, desempeño, firma digital, mensajería interna o cálculos de nómina nuevos. No copiar datos ni indicadores de ejemplo de las imágenes como si fueran reales.
