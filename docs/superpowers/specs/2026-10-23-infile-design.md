# Integración Infile FEL en Auna — diseño propuesto

Fecha: 23 de octubre de 2026. Estado: **propuesta para aprobación; no autoriza emisiones, instalaciones ni despliegues**.

## 1. Objetivo y alcance

Permitir que cada empresa configure Infile, complete pruebas verificables y habilite producción conscientemente. Certificar facturas y gestionar sus ajustes sin repetir ventas, cobros, movimientos de stock ni asientos comerciales. Usar las plantillas visuales existentes para representar los documentos reales certificados.

Alcance propuesto de la primera versión completa: Infile unificado; empresas y establecimientos/sucursales; GTQ; facturas FACT y FPEQ cuando el perfil haya sido validado; notas de crédito NCRE y anulación con sus respectivos casos aprobados. No anunciar soporte de un régimen, tipo, impuesto, moneda o ajuste que no haya pasado las pruebas de ese perfil. En particular, el ajuste aplicable a FPEQ debe confirmarse y probarse antes de habilitar ese perfil con devoluciones.

FCAM, FESP, exportaciones, impuestos específicos, otros complementos y monedas distintas de GTQ no se incluyen automáticamente. Si una operación necesita alguno, queda bloqueada con un motivo y no se convierte silenciosamente a FACT. La política FACT/FCAM para operaciones a crédito se confirma con Infile/asesoría fiscal antes de habilitar ventas a crédito de ese perfil. No se asume que una venta pendiente de pago implique un tipo legal determinado.

Fuera de alcance: implementar Digifact/Megaprint/G4S, conectores arbitrarios cargables por clientes, firma local con PFX, integración directa como certificador SAT, WhatsApp, reescribir el POS, MRP, nuevos asientos fiscales automáticos, ni habilitar contingencia legal CAFE sin su contrato y validaciones específicos. Una cola técnica pendiente NO equivale a contingencia legal autorizada.

## 2. Evidencia y límites de lo conocido

- Auna ya tiene `SaleDte`, solicitudes `PENDING_CONNECTOR`, historial de venta, confirmación comercial idempotente y trabajadores de documentos PDF con almacenamiento privado. Las solicitudes actuales no certifican nada.
- `fiscalRequests.js` solicita automáticamente para ventas POS nuevas con `fel_enabled`; las ventas confirmadas por otros flujos tienen solicitud explícita. Se preserva esa distinción.
- Los documentos visuales admiten `INTERNAL_RECEIPT` y muestras `FEL_INVOICE`, pero publicación/render real FEL están bloqueados. Un cambio de propósito sin certificación no es válido.
- No existe un desglose fiscal histórico completo en `Sale`/`SaleItem`. El snapshot comercial no basta para reconstruir impuestos antiguos utilizando la configuración de hoy. Se necesita un snapshot fiscal nuevo, preciso e inmutable.
- El código Odoo recuperado usa XML y las cabeceras `UsuarioFirma`, `LlaveFirma`, `UsuarioApi`, `LlaveApi`, `identificador`; observa `resultado`, `uuid`, `serie`, `numero`, `fecha`, `xml_certificado`. Es evidencia de implementación, no documentación vigente del proveedor.
- Esas copias tienen problemas que NO se trasladan: `verify=False`, esperas HTTP sin límite, identificador regenerado y XML completo en logs. Se respetan sus licencias; no se copian módulos LGPL/AGPL a Auna sin revisar derechos y obligaciones.
- Fuentes: [inventario y conclusiones locales](../../../../referencias/fel-servidores-2026-10-23/README.md); [Infile Guatemala](https://infile.com/guatemala); [soporte técnico oficial](https://basedeconocimientos.infile.com/acuerdo-de-nivel-de-servicio-sla-soporte-t%C3%A9cnico). Las dos páginas oficiales no especifican el contrato completo del API.
- Se intentó consultar [documentación técnica SAT](https://portal.sat.gob.gt/portal/documentacion-tecnica-del-regimen-fel/); devolvió HTTP 403 en esta revisión. No se declara verificado el esquema/reglamento vigente a partir de copias antiguas.

### Puerta externa G0: datos que Infile debe confirmar

Guardar manual/versión/fecha/huella y ejemplos anonimizados: endpoints exactos y mecanismo de aislamiento de pruebas/producción; significado y alcance de las cuatro credenciales; límites/formato/alcance/ventana del identificador; procedimiento de consulta/recuperación de un envío sin respuesta; respuestas de rechazo, duplicado, certificación y anulación; significado de aceptación/certificación frente al estado SAT; XSD oficiales completos y reglas vigentes; tipos/complementos/regímenes; límites de receptor/CF y fechas; redondeos y descuentos; requisitos comerciales/de aprobación de la cuenta.

No se inventan endpoint de consulta, sandbox, encabezados extra, plazo de idempotencia, límites legales ni un supuesto API que diga «Infile aprobó». Cambiar la URL puede o no ser necesario según el contrato de la cuenta. Si el aislamiento o la recuperación no están confirmados, no se habilita tráfico real. El desarrollo con simulador sí puede avanzar.

## 3. Decisiones propuestas de arquitectura

Son decisiones del autor del plan, pendientes de aprobación del usuario: Node.js/Express/Prisma/PostgreSQL actuales; HTTP nativo y `node:crypto`; cola PostgreSQL, sin Redis, microservicio PHP/Python ni SDK de comunidad como dependencia de producción. Un módulo `src/modules/fiscal` encapsula Infile; no un framework de plugins genérico.

Se propone `@xmldom/xmldom` 0.9.12, versión observada en npm durante esta revisión, para construir/leer XML por nodos con namespaces, sin concatenar datos no escapados. Antes de instalar se revisan avisos y se fija una versión soportada en lockfile. Validación XSD mediante libxml2/xmllint del runtime desplegado, actualizada por su distribución y comprobada en CI. No usar `saxes` como nueva dependencia: su repositorio aparece archivado. Ausencia del validador o esquemas bloquea el perfil, no omite validación.

### Tres estados distintos

1. Intención del negocio: `fel_enabled` conserva el significado «este negocio quiere emitir FEL».
2. Preparación del conector: `DRAFT → TESTING → TEST_PASSED → PRODUCTION_READY`, con `PAUSED` y `REVOKED`. `TEST_PASSED` no activa producción.
3. Estado fiscal del documento: pendiente, enviando, resultado desconocido, rechazado, certificado o anulado. No se deriva solo de las dos opciones anteriores.

El proceso de pruebas y el de producción son registros distintos por empresa. La producción exige activación explícita por administrador autorizado, evidencia vinculada a la revisión de configuración/credenciales, perfiles aprobados, establecimientos completos, runtime listo y bandera de despliegue habilitada. «Aprobación registrada» identifica una confirmación administrativa local con actor y evidencia, no una validación automática de Infile. Cambiar NIT, cuenta, entorno, perfil o establecimiento invalida la preparación correspondiente; rotar claves exige una nueva revisión y no hereda aprobación silenciosamente.

## 4. Experiencia de usuario

`Configuración → Conectores → Infile`, conservando sidebar y patrones Auna. Entrada «Personalizado — próximamente» deshabilitada; no formulario de URLs libres. Tres apartados: Conexión, Pruebas y Actividad. Datos fiscales permanecen en su sección, con enlaces entre ambas. No duplicar NIT/razón social en formularios con fuentes contradictorias: guardar perfil fiscal versionado a partir de la configuración confirmada.

- Cuatro campos con etiquetas «Usuario de firma», «Llave de firma», «Usuario API», «Llave API»; secretos de escritura únicamente. Mostrar «Configurada» y fecha, no recuperar claves guardadas al navegador. Campo ausente conserva; cadena vacía se rechaza; borrar/rotar es una acción explícita.
- Establecimiento por sucursal: código como texto, nombre, dirección, municipio, departamento y código postal; normalización según G0, sin convertir códigos a números y perder ceros. Bloqueo si falta mapeo.
- «Validar configuración» no envía DTE ni afirma credenciales válidas: revisa campos, permisos, runtime y esquemas. «Ejecutar prueba» avisa expresamente del contacto con el proveedor, es exclusivo del entorno de pruebas confirmado y produce evidencia. No emitir una factura real al hacer ping.
- Checklist de pruebas, resultados con códigos entendibles, fecha y revisión; no mostrar trazas, headers, XML completo o credenciales en alertas.
- Producción requiere confirmación separada. No existe botón «aprobar todo» que salte G0 o pruebas.
- Ventas/POS muestran estado compacto y acciones contextuales. Pago confirmado no se transforma en error de cobro por fallo fiscal. No añadir un box invasivo ni congelar todo el POS esperando al certificador.
- Permisos propuestos: `fiscal.view`, `fiscal.manage`, `fiscal.test`, `fiscal.activate`, `fiscal.retry`, `fiscal.cancel`, `fiscal.download`. Mantener `sales.fiscal.register` para solicitar una factura. Cada permiso se verifica en servidor; lectura de actividad/documentos respeta empresa y sucursales autorizadas. Un administrador de empresa no administra otra.
- Reutilizar ConfirmDialog, notificaciones, controles y guardas de cambio de empresa/sucursal/sesión de Auna. AbortController y descarte de respuestas antiguas; vistas sin polling cuando están ocultas.

## 5. Credenciales, red y XML

- Credenciales cifradas con AES-256-GCM: nonce aleatorio de 12 bytes por escritura, tag de 16 bytes y AAD con `companyId`, `connectorId`, `environment`, `credentialVersion`. Nunca almacenar claves FEL en `SystemSetting`, snapshots, historial, frontend ni variables `VITE_*`.
- Keyring del servidor: `FISCAL_ENCRYPTION_KEYS_JSON` y `FISCAL_ACTIVE_KEY_ID`, provisionados por secret manager del despliegue; claves maestras fuera de PostgreSQL. Validar claves de 32 bytes; faltar clave o autenticación GCM fallida cierra el acceso, no cae a texto plano. Mantener claves anteriores mientras existan datos cifrados referidos; rotación con ensayo de restauración. El keyring por entorno es el mínimo inicial, no una afirmación de aislamiento frente a un servidor totalmente comprometido.
- `FISCAL_ALLOW_PRODUCTION=false` por defecto. `FISCAL_INFILE_ENDPOINTS_JSON` es política de operador, no setting editable por cliente. Solo URLs HTTPS exactas verificadas en G0, sin redirecciones ni direcciones privadas/loopback/link-local/metadata. Resolución y conexión deben quedar ligadas a la misma política; no basta validar DNS y luego resolver de nuevo sin control. Restringir salida de red del trabajador cuando el hosting lo permita.
- TLS validado siempre; petición con AbortSignal de 20 s total (decisión operativa inicial, no SLA Infile). XML emitido/recibido máximo 2 MiB; respuesta HTTP máximo 4 MiB; hasta 500 líneas, profundidad 64 y 50.000 nodos. Ajustar límites solo tras medición y contrato, no usar modo XML «huge».
- XML UTF-8 estricto; rechazar DTD/ENTITY, XInclude y construcciones externas antes de parsear. Rechazar errores/warnings estructurales y nodos duplicados protegidos; leer por namespace y ruta, no por primer `localName` coincidente. Lector y validación ejecutados en proceso aislado con 128 MiB y 5 s; child sin credenciales ni conexión DB. XSD/imports locales fijados por huella; no resolver `schemaLocation` del documento por red o filesystem arbitrario. `--nonet` solo es defensa adicional, no todo el aislamiento.
- XSD no valida toda la normativa ni prueba autenticidad de una firma XML. Además de XSD, comprobar totales, emisor, receptor, moneda, tipo y autorización de la respuesta respecto al snapshot. La primera versión confía en el canal TLS del proveedor y en su contrato confirmado; no anuncia verificación criptográfica XMLDSig propia ni aceptación SAT independiente.
- No emitir hacia URLs proporcionadas por el navegador. No descargar automáticamente cualquier `pdf_url`/URL del JSON. XML certificado en bucket privado; descargas autorizadas por servidor con `private, no-store`, límites y huella. No usar el visor HTML/XML del navegador como ejecución de contenido.
- Auditoría y logs operativos se conservan. Registrar identificadores internos, estado, duración y código saneado; no cuerpo HTTP, datos personales, cabeceras ni secretos. Los mensajes de proveedor se saneen antes de persistir/exponer. Respaldar DB, objetos fiscales y keyring por procedimientos separados; no fijar un plazo de borrado fiscal sin revisión legal.

## 6. Persistencia y contratos

Modelos propuestos (nombres definitivos para la implementación):

| Modelo | Responsabilidad |
| --- | --- |
| `FiscalConnector` | Empresa, proveedor `INFILE`, entorno `TEST`/`PRODUCTION`, estado, versión actual y revisión; único empresa/proveedor/entorno. |
| `FiscalConnectorVersion` | Configuración, perfil/contrato y credenciales cifradas inmutables, key id, revisión, actor y evidencia de habilitación. Operaciones fijan una versión. |
| `FiscalEstablishment` | Mapeo empresa/conector/sucursal y perfil de establecimiento, con revisión; datos se congelan en cada operación. |
| `FiscalOperation` | Acción `ISSUE`/`CANCEL`/`CREDIT_NOTE`, origen, entorno, snapshot, XML exacto/huella/ruta, identificador estable, estado, lease y siguiente intento. Admite casos sintéticos TEST sin venta real. |
| `FiscalAttempt` | Intento de transporte/inbox durable: operación, número, inicio, resultado saneado, referencia privada a respuesta y huella. Sin secretos. |
| `FiscalEvent` | Auditoría append-only de configuración, pruebas, activaciones, envíos, conciliaciones y anulaciones. Metadatos mínimos, actor y motivo. |

Extender `SaleDte` con entorno, vínculo a operación y referencia privada de XML; conservar autorización/serie/número/fecha y datos legacy. No introducir autorizaciones TEST en ventas reales. Extender `Sale.fiscal_snapshot Json?` y `DocumentSnapshot.fiscal_document_id` para que originales y ajustes no se confundan por compartir venta. Datos nuevos y archivos fiscales tienen FK `Restrict`; no borrado en cascada de evidencia.

Constraints/índices: FKs compuestas de empresa/sucursal/origen/conector; vínculo entorno-conector-version coherente; identificador único empresa/proveedor/entorno; autorización normalizada única empresa/proveedor/entorno cuando no nula; una ISSUE activa por venta y una CREDIT_NOTE por devolución/resolución; CANCEL única por documento original. Índices parciales de cola `(available_at,id)` por estado, leases y actividad `(company_id,branch_id,created_at,id)`. Auditar duplicados legacy antes de crear índices: no borrar ni normalizar historia ambigüa automáticamente.

API propuesta:

- `/api/config/connectors`: catálogo y capacidades, sin secretos; `/infile/:environment` GET/PUT con revisión esperada y clave de idempotencia; acciones `/validate`, `/tests`, `/activate`, `/pause`, `/history`.
- Conservar `/api/sales/:id/invoice-request`. Agregar lectura fiscal y acciones con `documentId`: `/api/sales/:id/fiscal-documents`, `/:documentId/reconcile`, `/:documentId/cancel`, `/:documentId/xml`. Reintentar PDF usa su API actual y jamás dispara certificación.
- Ajustes ligados a devolución por servicio interno y endpoint explícito de usuario cuando requiera corrección. Nunca crear una nota automáticamente desde un GET, cambio de plantilla o cambio de configuración.
- Todos los comandos incluyen `expectedVersion`, `idempotencyKey`; cancelar incluye motivo. PUT de credenciales no devuelve el payload recibido. Conflictos `409`, sin recursos ajenos `404`, permisos `403`, configuración inválida `422`; trabajo aceptado `202` con estado/ID. Límites y rate limiting por actor/empresa para comandos de prueba/emisión.

## 7. Flujo comercial, fiscal y recuperación

Antes del commit de una venta POS nueva que pretende FEL en producción: validar localmente perfil, establecimiento y receptor; congelar líneas, presentaciones/unidades SAT mapeadas, descuentos, impuestos y totales con `Prisma.Decimal`. En la misma transacción comercial registrar solicitud y operación en cola; **cero HTTP, generación PDF o subida de archivos externos en esa transacción**. Si hay error local de datos fiscales, mostrar campos antes de cobrar. Si Infile está caído, la venta comercial queda confirmada con solicitud fiscal pendiente, explícitamente no certificada.

Ventas manuales: confirmar borrador sigue siendo comercial; se congela el contexto fiscal al confirmar cuando FEL está preparado. La emisión se solicita desde su acción actual. Ventas derivadas de cotización o contratación conservan sus vínculos y se solicitan desde la venta confirmada, no desde la cotización. No automatizar facturación de anticipos de Agenda por este cambio.

Para ventas legacy sin snapshot fiscal, solicitud explícita exige revisión de datos y soporte del perfil/fechas. No usar impuestos actuales sobre precios antiguos ni emitir todo el histórico al activar. `PENDING_CONNECTOR` anterior se conserva y se muestra en una bandeja; el administrador selecciona documentos y confirma preparación uno por uno o lote acotado con vista previa, sin drenaje automático.

Estados de operación: `QUEUED → SENDING → ACCEPTED → DONE`; `REJECTED` para rechazo definitivo documentado; `BLOCKED` para impedimento local; `UNKNOWN` para respuesta ausente/ambigua. `ACCEPTED` significa respuesta válida y durable pendiente de materialización, no ticket listo. ISSUE/NCRE DONE proyectan el documento como `CERTIFIED`; CANCEL DONE proyecta `CANCELLED`. No usar una cadena AUTHORIZED para marcar un documento cuya respuesta no pasó validación.

1. Tomar lease `FOR UPDATE SKIP LOCKED`, persistir identificador, XML exacto, versión e inicio de intento antes del HTTP. Al expirar lease de un `SENDING`, pasa a UNKNOWN, nunca directamente a QUEUED.
2. Desencriptar solo en el proceso de transporte, enviar una vez, guardar respuesta como inbox durable privado y metadatos. HTTP 200 sin campos completos no es éxito. Un 5xx, timeout, conexión rota, respuesta malformada o crash después del envío pueden ser resultado desconocido.
3. Validar respuesta y XML; persistir certificación y eventos con lease/token fencing y unicidad. Luego generar PDF/ticket por el trabajador existente. Error de storage/render reintenta materialización, no el HTTP.
4. Recuperación UNKNOWN por mecanismo confirmado en G0, con el mismo identificador/XML. Si requiere reenvío idempotente, solo dentro de garantías documentadas y sin modificar cuerpo/fecha; nunca asumir ventana de 24 h. Si no hay recuperación automática garantizada, mantener UNKNOWN y resolver con evidencia del proveedor y usuario autorizado, no con botón «forzar nueva factura».
5. Reintentos de pasos locales o consultas seguras: 30 s, 2 min y 10 min, máximo tres automáticos; luego revisión manual. Un reenvío potencialmente mutante nunca se justifica solo por este temporizador. Preservar evidencia y permitir reanudar la misma operación mediante acción auditada.
6. Una corrección después de rechazo definitivo puede crear nueva revisión/identificador, ligada a la rechazada y solo con certeza de no certificación. No cambiar total/stock de la venta confirmada ni inventar un nuevo intento si el estado era UNKNOWN.

Rotación/pausa: antes de enviar comprobar que la versión sigue habilitada para esa operación. Pausa impide nuevos envíos; no borra trabajos/evidencia. Operaciones UNKNOWN deben poder consultar/recuperar con la cuenta original bajo permiso de recuperación, sin volver a emitir. Versiones históricas no se sustituyen automáticamente por la clave de otra cuenta. Respaldo/rotación no elimina claves maestras todavía referidas.

### Ajustes y anulación

Anulación fiscal y cancelación comercial son comandos distintos. Motivo y confirmación explícita; validar plazos/tipos desde el contrato/reglas, no hardcodear límites supuestos. Rechazo de anulación conserva la factura certificada. Resultado UNKNOWN de anulación no se etiqueta «anulada» ni dispara devolución/reembolso.

NCRE se liga al UUID original y a una devolución/resolución concreta; cantidades/importes positivos, acumulados bajo bloqueo del original y con reserva de ajustes pendientes para no exceder lo certificado. La cola espera a que el original tenga certificación inequívoca. No anular el total por una devolución parcial ni llamar «nota de crédito» a un comprobante interno. El flujo comercial existente de devolución conserva su propia idempotencia; el fallo fiscal no vuelve a reembolsar ni reingresar stock. Si el perfil no soporta ese ajuste, queda visible `BLOCKED` y no se habilita ese perfil para operación real con devoluciones hasta resolverlo.

## 8. Impuestos, documentos y rendimiento

Perfil fiscal versionado contiene tipos permitidos, afiliación, reglas de receptor y unidades SAT. Mapeo explícito para bienes/servicios y presentaciones; no enviar códigos internos de familia como códigos SAT. No utilizar un IVA fijo para todos los regímenes. Conservar descuentos y precios netos ya confirmados; el cálculo fiscal se hace sobre la misma base y distribución de descuentos, con reglas y escala validadas en G0. Si no hay igualdad exacta de centavos entre líneas/impuestos/total, bloquear, nunca parchear centavos en silencio. Casos obligatorios: fracciones, presentaciones, promociones, descuento global, exención, servicios y crédito según perfiles admitidos.

Producción preparada determina la opción ordinaria de plantillas FEL; ocultar creación/selección ordinaria de comprobante interno, pero preservar originales internos históricos y su descarga autorizada. Sin producción preparada, interno sigue siendo documento operativo y FEL solo muestra claramente muestras/pruebas. Un documento individual pendiente/rechazado nunca usa apariencia de certificado.

Tras certificar: el XML original es inmutable; la representación usa snapshot fiscal y perfil visual capturado para ese documento. Ticket 80 mm por defecto, monocromo, logo del negocio; factura Clásico FEL Carta, con opciones actuales A4. UUID, serie, número, fecha, emisor, receptor, importes y verificación protegidos frente al editor. Link/QR se construyen únicamente con la especificación oficial confirmada, no con una URL inventada ni un endpoint de terceros. Un PDF es representación, no reemplaza XML certificado.

Plantilla editada después no cambia originales; fallo PDF no invalida certificación ni provoca otro envío. La UI ofrece consultar/reimprimir sin duplicar cobro. En producción preparada y documento pendiente no autoimprimir un falso FEL ni reemplazarlo silenciosamente por interno: mostrar «Venta registrada; factura en certificación» y preparar impresión cuando haya certificado. Registrar un intento de impresión por intención, no por cada actualización de estado. No prometer éxito de impresión física desde el navegador.

Objetivos internos propuestos: trabajo agregado por encolado p95 ≤ 300 ms y respuesta de solicitud fiscal p95 ≤ 500 ms en benchmark representativo, excluyendo duración previa del checkout y red Infile; ningún tiempo garantizado para certificación externa. Medir costo real antes/después, tiempo de cola, respuesta Infile, materialización y PDF por separado. Trabajador inicial con concurrencia global 2 y máximo una operación en vuelo por conector/empresa; revisar capacidad con medición y cuotas confirmadas. Polling de UI cada 2 s por un máximo de 60 s y solo visible; después consultar manualmente sin repetir comandos.

## 9. Pruebas, habilitación y operación

Etapa local sin credenciales: pruebas unitarias de cifra, permisos, estados, mapeo Decimal, XML malicioso y límites; simulador de proveedor; crash antes/después de envío y después de respuesta; duplicados, dos workers, fencing, rotación, aislamiento entre empresas/sucursales; migración probada en PostgreSQL desechable. Pruebas no deben depender de coincidencias de texto de fuentes.

Etapa TEST: fixtures sintéticos independientes de ventas/caja/stock reales; casos aprobados con Infile para cada régimen/tipo: emisión, rechazo, caracteres, descuentos/redondeos, unidades/presentaciones, anulaciones, notas/crédito, duplicado y recuperación. Evidencias ligadas a versión/perfil. No certificar fixtures en producción. No tratar pruebas simuladas como aprobación del proveedor.

Etapa producción: aprobación administrativa registrada y verificable; usuario confirma primera operación real que necesita el negocio, sin «factura de Q1 y anulación automática» como rutina técnica. Verificación portal/proveedor/SAT según procedimientos vigentes. Habilitar una empresa/sucursal piloto y ampliar después de comprobar certificación, recuperación y representación. Aprobar cada perfil y cuenta; no heredar pruebas de otra empresa.

Runbook: instalar/validar worker, keyring y esquemas antes de habilitar; alertar cola envejecida, UNKNOWN, rechazos y errores de claves/storage; pausar envíos sin borrar nada; recuperar con evidencia; restaurar DB+objetos+keyring en ensayo aislado con tráfico fiscal bloqueado. Volver al backend anterior requiere primero pausar envíos y comprobar compatibilidad de estados; nunca resetear la base ni quitar evidencia certificada. No declarar cronograma externo de aprobación garantizado.

## 10. Aceptación y decisiones pendientes

Se acepta cuando: una venta se confirma una vez; toda factura real proviene de una operación autorizada y recuperable; un timeout no habilita duplicación; TEST jamás aparece como factura de venta real; PDF fallido no reenvía; secretos nunca salen por GET/logs; FK/índices y concurrencia se verificaron en PostgreSQL real de prueba; activación no emite el histórico; reimpresión conserva originales; y ajustes no duplican stock/dinero ni exceden el original.

Pendiente del usuario: aprobar el diseño y el alcance limitado de perfiles/tipos propuesto. Pendiente externo: G0 y credenciales/cuenta TEST autorizada, evidencia administrativa para producción y revisión fiscal de los perfiles. Pendiente del implementador: detalle visual dentro de componentes Auna, optimización medida y despliegue exacto según hosting, sin debilitar límites/permisos ni expandir tipos admitidos.
