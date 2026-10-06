# RRHH: expediente y documentos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans para ejecución nativa o superpowers:subagent-driven-development si el usuario elige delegación. Ejecutar una tarea verificable a la vez; los pasos usan casillas de seguimiento.

**Goal:** Corregir listado, alta y detalle de empleados para reproducir las referencias claras/oscuras, con expedientes documentales configurables y privados en `hr`.

**Architecture:** Extender el módulo RRHH existente, sin reemplazar las reglas de nómina. Separar validación documental, almacenamiento privado y operaciones transaccionales; usar modelos relacionales para requisitos, documentos e historial. Reutilizar las primitivas visuales existentes, aplicando composición y estilos acotados a RRHH.

**Tech Stack:** Express, Prisma 6/PostgreSQL, Supabase Storage, React/TypeScript, TanStack Query, Radix/Tailwind y pruebas `node:test`. Sin nuevas dependencias de producción.

**Spec:** `/home/DiegoPatzan/Documents/CODE/Auna/deposito-backend/docs/superpowers/specs/2026-10-05-hr-expediente-documentos-design.md`

## Global Constraints

- El bucket existente se llama `hr` y debe ser privado. No modificar su política automáticamente.
- PDF, JPEG y PNG; hasta 5 MB por archivo; validar contenido en servidor.
- Los requisitos documentales pertenecen a cada empresa y empiezan sin obligatorios.
- Mantener lectura de fotografías anteriores; nuevas fotografías usarán `hr` con ruta privada y URL temporal.
- Preservar empleados, fotografías y anticipos existentes mediante migraciones aditivas.
- No inventar historial previo, comparaciones mensuales ni indicadores.
- Conservar DPI, NIT, IGSS, bonificación incentivo, frecuencia y forma de pago.
- No suspender empleados ni alterar nómina por expedientes incompletos.
- CSS acotado a RRHH; conservar la navegación global del ERP.
- Respetar empresa, sucursal y permisos en cada operación y descarga.
- Las modificaciones existentes en ambos repositorios son el punto de partida: no descartarlas ni incorporarlas a commits sin autorización. Este plan no autoriza commits, pushes ni despliegues.

## Review Focus

1. Alta que sí se guardó pero cuya respuesta se perdió: el reintento devuelve el mismo empleado, sin duplicarlo. Prueba en tarea 3.
2. Requisito modificado mientras el usuario llena el formulario: validar la configuración vigente y conservar sus selecciones ante un conflicto. Pruebas en tareas 3 y 6.
3. Archivo con MIME/extensión falsificados, nombre malicioso o bucket público: rechazar sin persistir metadatos ni publicar datos. Pruebas en tarea 2.
4. Usuario de asistencia sin acceso a expedientes: puede consultar el equipo mínimo, nunca salario, DPI ni documentos. Prueba en tarea 4.
5. Documento reemplazado mientras otro usuario lo abre: conservar versión archivada, autorización vigente y selección correcta de versión. Prueba en tarea 3.

## Mapa de archivos

Raíz backend: `/home/DiegoPatzan/Documents/CODE/Auna/deposito-backend`.
Raíz frontend: `/home/DiegoPatzan/Documents/CODE/Auna/deposito-frontend`.

Backend: `prisma/schema.prisma`, nueva migración `prisma/migrations/<timestamp>_hr_employee_documents/migration.sql`, `prisma/seed.js`, `src/config/permissionDeps.js`, `src/modules/hr/routes.js`, controladores existentes de empleados y archivos nuevos `domain/documents.js`, `documentStorage.js`, `employeeApplication.js`, `controllers/documents.js`, `controllers/documentTypes.js`, `controllers/employeeHistory.js`, `controllers/employeeDirectory.js` bajo `src/modules/hr/`.

Frontend: `src/services/hrService.ts`, páginas actuales de `src/modules/hr/pages/`, nuevos componentes allí `EmployeeForm.tsx`, `EmployeeDocumentsPanel.tsx`, `EmployeeHistory.tsx`, `EmployeeQuickSummary.tsx`, `EmployeeRecentRecords.tsx`, `EmployeePicker.tsx`, `EmployeeRecordExport.ts` y `hr.css`. Configuración: nuevo `src/modules/config/pages/HrDocumentsSettings.tsx`, integrado en `ConfigManagement.tsx`.

No añadir un framework de formularios, una segunda tabla global ni un sistema genérico de gestión documental.

---

### Tarea 1: Modelos, validación y catálogo de permisos

**Files:** modificar schema, migración, seed y permissionDeps; crear `src/modules/hr/domain/documents.js`, `tests/hr.documents.domain.test.js`, `tests/hr.documents.schema.test.js`.

**Interfaces producidas:**

```js
// documents.js, CommonJS; errores con status HTTP y mensaje legible.
normalizeDocumentType(input) // { name, instructions, required, active, sort_order }
validateDocumentFile(file) // { mimeType, extension, size, sha256 }
assertRequiredDocuments(types, selectedTypeIds) // void; 422 si falta alguno
// file: { buffer: Buffer, originalname: string, mimetype: string, size: number }
```

- [ ] Escribir pruebas antes del código y observar fallos por funciones/modelos inexistentes. Incluir:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { assertRequiredDocuments, normalizeDocumentType } = require('../src/modules/hr/domain/documents')
test('requisitos vacíos no bloquean el alta', () => assert.doesNotThrow(() => assertRequiredDocuments([], [])))
test('un requisito activo falta', () => assert.throws(() => assertRequiredDocuments([{ id: 'dpi', active: true, required: true }], []), e => e.status === 422))
test('inactivo no se exige', () => assert.doesNotThrow(() => assertRequiredDocuments([{ id: 'dpi', active: false, required: true }], [])))
test('el tipo requiere nombre', () => assert.throws(() => normalizeDocumentType({ name: ' ' }), e => e.status === 400))
```

- [ ] Crear los tres modelos de la especificación. `EmployeeDocumentType`: UUID, company_id, name (100), instructions (500), required=false, active=true, sort_order y timestamps. `EmployeeDocument`: UUID, company_id, employee_id, type_id, storage_path, original_name (255), mime_type, size_bytes, sha256, uploaded_by, created_at, archived_at nullable. `EmployeeHistory`: UUID, company_id, employee_id, actor_id nullable, event, changes JSON y created_at. Relaciones con borrado Restrict e índices por empresa/empleado/fecha.
- [ ] Agregar un índice único parcial PostgreSQL para `(employee_id, type_id) WHERE archived_at IS NULL`. No simularlo con un unique que incluya un nullable.
- [ ] Agregar a Employee campos opcionales gender, marital_status, nationality, work_schedule, workday, supervisor_id, photo_storage_path; supervisor con autorrelación y onDelete SetNull. Agregar creation_request_id y creation_request_hash opcionales y unique `(company_id, creation_request_id)` para el alta idempotente. No exponer el hash en DTO.
- [ ] Agregar `hr.documents.view`, `hr.documents.manage`, `hr.documents.archive`. Manage y archive implican view, no salario ni settings. Incorporar al catálogo y rol administrador siguiendo el seed; no ejecutar el seed completo sobre staging para concederlos indiscriminadamente.
- [ ] Implementar validación con trim/límites, booleanos estrictos, orden entero no negativo, selección sin IDs duplicados y errores específicos. Para firma de archivo: PDF empieza `%PDF-`, JPEG `FF D8 FF`, PNG firma completa de ocho bytes. Comparar MIME declarado con firma, rechazar vacío y >5*1024*1024 bytes.
- [ ] Ejecutar `node tests/hr.documents.domain.test.js`, `node tests/hr.documents.schema.test.js`, `npx prisma validate` y `npx prisma generate`. Generar SQL aditivo, revisar que no hay DROP de datos existentes y aplicarlo con `prisma migrate deploy` a staging solo al verificar el destino sin mostrar credenciales.

### Tarea 2: Almacenamiento privado en `hr`

**Files:** crear `src/modules/hr/documentStorage.js`, `tests/hr.documentStorage.test.js`; reutilizar cliente de `src/services/supabaseStorage.js` mediante un export específico si no se puede acceder actualmente, sin modificar sus helpers públicos.

**Interfaces:**

```js
assertPrivateHrBucket() // Promise<void>, 503 si falta o es público
uploadHrFile({ companyId, employeeId, file }) // Promise<{ path, mimeType, extension, size, sha256 }>
signHrFile(path, { downloadName }) // Promise<{ url, expiresAt }>, TTL 300 segundos
removeNewHrFiles(paths) // Promise<void>, solo rutas nuevas autorizadas por la operación
```

- [ ] Escribir y ejecutar pruebas rojas: bucket público; bucket faltante; extensión `.pdf` con bytes PNG; nombre `../../DPI.pdf`; archivo vacío; límite exacto y excedido; fallo de subida; error de firma. Simular únicamente el SDK, no las funciones bajo prueba.

```js
test('un bucket público no permite subir', async () => {
  sdk.storage.getBucket = async () => ({ data: { public: true }, error: null })
  await assert.rejects(assertPrivateHrBucket(), e => e.status === 503)
  assert.equal(uploadCalls, 0)
})
```

- [ ] Generar rutas con `crypto.randomUUID()` y la extensión validada: `${companyId}/employees/${employeeId}/${randomUUID()}.${extension}`; `upsert:false`, MIME validado y no getPublicUrl. No aceptar una ruta del navegador. Limpiar nombres para Content-Disposition, no para identificar objetos.
- [ ] Verificar privacidad antes de habilitar cargas; no crear, publicar ni cambiar bucket desde este flujo. No cachear indefinidamente una comprobación positiva.
- [ ] Firmar por 300 segundos solo después de autorización del controlador; no registrar la URL ni el documento. Errores de Supabase se traducen a 503 con mensaje seguro. Respuestas privadas con `Cache-Control: private, no-store`.
- [ ] Ejecutar las pruebas verdes y comprobar que el helper de imágenes públicas de otros módulos conserva su comportamiento.

### Tarea 3: Tipos configurables, alta robusta y documentos versionados

**Files:** crear `employeeApplication.js`, controladores documents/documentTypes; modificar employees.js y routes.js; crear `tests/hr.documentTypes.test.js`, `tests/hr.employeeCreate.documents.test.js`, `tests/hr.employeeDocuments.test.js`.

**Contratos HTTP — base `/api/hr`:**

```text
GET /document-types -> { items: DocumentType[] }; tipos activos para alta/gestión
GET /document-types?includeInactive=1 -> catálogo administrativo
POST /document-types -> DocumentType
PUT /document-types/:typeId -> DocumentType
POST /employees -> Employee DTO; JSON o multipart
GET /employees/:id/documents -> { items: DocumentVersion[], requirements: DocumentType[], complete: boolean }
POST /employees/:id/documents -> DocumentVersion; multipart file + type_id
POST /employees/:id/documents/:documentId/access -> { url, expiresAt }; body { download: boolean }
POST /employees/:id/documents/:documentId/archive -> DocumentVersion
POST /employees/:id/documents/:documentId/restore -> DocumentVersion
```

DocumentType DTO usa `id,name,instructions,required,active,sort_order`. DocumentVersion DTO usa `id,type_id,original_name,mime_type,size_bytes,created_at,archived_at,uploaded_by`; no incluye storage_path ni URL persistente. Employee DTO conserva photo_url para imágenes legadas y temporales, agrega photo_expires_at cuando corresponda.

- [ ] Pruebas rojas de catálogo: empresa distinta; renombrar con documentos ya existentes; desactivar conserva versiones; todos opcionales por defecto; solo settings.manage puede mutar. GET administrativo exige settings.view/manage; GET activo acepta empleado-create, documents.view/manage o settings según la semántica OR del middleware existente.
- [ ] Implementar CRUD sin DELETE de requisitos. Los IDs de empresa provienen de req.companyId, nunca del body. Comparar la empresa del tipo con la del empleado en las mutaciones documentales.
- [ ] Pruebas rojas de alta: JSON sin requisitos funciona; JSON con obligatorios devuelve 422; multipart completo; faltante; archivos duplicados por tipo; fallo de storage; fallo transaccional; respuesta perdida/reintento; misma clave con contenido distinto devuelve 409. No llamar a storage dentro de una transacción de Prisma.

```js
test('el reintento del alta no duplica al empleado', async () => {
  const first = await createEmployeeWithDocuments(ctx, payload, files, 'request-a')
  const second = await createEmployeeWithDocuments(ctx, payload, files, 'request-a')
  assert.equal(second.id, first.id)
  assert.equal(employeeCreateCalls, 1)
})
```

- [ ] Implementar `createEmployeeWithDocuments(ctx, payload, files, requestId)` en employeeApplication. Contexto `{companyId,branchId,userId,permissions}` derivado de autenticación. Multipart: `payload` JSON, `manifest` JSON `{fieldName,typeId}[]` y archivos; `Idempotency-Key` UUID por intento lógico, retenido por el frontend durante reintentos. Hash canónico de payload+manifest+SHA256 de archivos. Reconsulta por clave antes de subir; si existe, verificar hash y alcance y devolver el mismo DTO.
- [ ] Validar el lote completo antes de subir. Máximo 20 archivos por petición y cada archivo 5 MB; limitar Multer fields/files/fieldSize. Subir a un employeeId UUID generado; transacción corta revalida requisitos activos, registra Employee/documentos/historial. Si cambió la política, devolver 409 con tipos faltantes y limpiar solo objetos nuevos. Una colisión de clave por solicitud concurrente devuelve el registro ganador si coincide el hash; limpia los objetos del intento perdedor. No borrar objetos del ganador.
- [ ] Pruebas rojas de reemplazo concurrente: dos reemplazos no dejan dos documentos vigentes; archivar conserva archivo; restaurar con otro vigente devuelve 409; acceso a versión de otro empleado o empresa devuelve 404/403 sin firmar.
- [ ] Implementar reemplazo como subida nueva y transacción que archiva la versión vigente e inserta la nueva. Utilizar el índice parcial y manejar colisión 409 sin perder la selección ni archivo anterior. Acceso y archivo/restauración autorizados cada vez por empresa, empleado, sucursal y permiso. No eliminar físicamente versiones antiguas.
- [ ] Migrar solo nuevas fotografías a hr mediante photo_storage_path. Conservar lectura pública legacy; regenerar URL temporal en DTO sin reemplazarla persistentemente. No borrar imágenes legadas en esta entrega.
- [ ] Ejecutar los tres archivos de pruebas y `npm test`. Pruebas de fallos deben comprobar recuento de empleados/documentos y rutas limpiadas, no solo el mensaje de error.

### Tarea 4: Expediente operativo, historial y búsquedas mínimas

**Files:** crear controllers/employeeHistory.js y employeeDirectory.js; modificar employees.js, attendance.js y routes.js; crear `tests/hr.employeeHistory.test.js`, `tests/hr.employeeDirectory.test.js`, ampliar `tests/hr.presentation.test.js`.

**Interfaces:**

```text
GET /employee-directory?q=&page=1&pageSize=10&purpose=attendance|advance|supervisor
 -> {items:[{id,code,first_name,last_name,position,branch:{id,name}}],page,pageSize,totalItems,totalPages}
GET /employees/:id/history?page=1&pageSize=10 -> página de {id,event,changes,actor:{id,name},created_at}
GET /employees/:id/overview?month=YYYY-MM
 -> {attendance:{marked,present},advances:{count,balance},history:{count},documents:{complete,missingRequired}}
```

- [ ] Escribir pruebas rojas para propósito no permitido, empresa/sucursal distintas, supervisor propio, campos sensibles ausentes y paginación estable. Attendance purpose exige hr.attendance.view/manage; advance exige hr.advances.manage; supervisor exige hr.employees.create/edit. No conceder hr.employees.view por gestionar asistencia.

```js
test('el directorio de asistencia no expone salario ni identificación', async () => {
  const result = await listDirectory(attendanceOnlyContext, { purpose: 'attendance', page: 1, pageSize: 10 })
  assert.equal(result.items[0].base_salary, undefined)
  assert.equal(result.items[0].dpi, undefined)
  assert.equal(result.items[0].photo_storage_path, undefined)
})
```

- [ ] Implementar queries con select mínimo y branchWhere existente. Lista y conteo de empleados: filtro por puesto y sucursal autorizado, orden ingreso/nombre más ID, tamaños limitados. “En licencia” calcula marcas vigentes usando timezone empresarial; activos sin licencia, en licencia y restantes se contabilizan sin duplicación. Suspensión no se convierte en licencia.
- [ ] Registrar cambios laborales, alta, baja, carga/reemplazo y archivo/restauración de documentos con autor en la misma transacción de su mutación. Diff solo de campos autorizados, sin objetos binarios ni URLs; no fabricar cambios históricos. Validar supervisor propio y referencia ajena en servidor.
- [ ] Implementar overview con agregaciones scoped y mes válido. Presentes son PRESENTE/TARDE sobre marcas registradas; explicar denominador. Anticipos son pendientes y saldo real. No descargar 1,000 registros para sumarlos en cliente. Historial de últimos tres meses contado en servidor.
- [ ] Ejecutar las pruebas nuevas y suite completa. Confirmar que los escenarios de nómina y cancelación de anticipos siguen verdes.

### Tarea 5: Preferencias documentales de Configuración

**Files:** crear `HrDocumentsSettings.tsx`; modificar ConfigManagement.tsx y hrService.ts. Backend consume tarea 3.

**Interfaces frontend:**

```ts
type DocumentType = { id: string; name: string; instructions: string; required: boolean; active: boolean; sort_order: number }
fetchHrDocumentTypes(options?: { includeInactive?: boolean }): Promise<{ items: DocumentType[] }>
createHrDocumentType(value: Omit<DocumentType, 'id'>): Promise<DocumentType>
updateHrDocumentType(id: string, value: Omit<DocumentType, 'id'>): Promise<DocumentType>
```

- [ ] Antes de implementar, probar que el panel aún no existe y registrar la expectativa de añadir, editar, ordenar y desactivar un requisito sin perder versiones.
- [ ] Integrar “Expedientes de empleados” dentro de las funciones existentes de Configuración; no reemplazar sus pestañas ni duplicar proveedores. Tabla shared, diálogo variant auna, nombre/instrucciones, switches obligatorio/activo y orden numérico. Desactivar con confirmación recuperable, no borrar.
- [ ] Usuarios settings.view ven lectura; settings.manage edita. Carga/error/reintento visibles. Mutaciones invalidan `hr-document-types` y `hr-employee-documents`; nunca mostrar guardado antes de confirmación del servidor.
- [ ] Prueba UI en staging con tipo de prueba opcional: guardar, renombrar, activar/desactivar y comprobar persistencia tras recarga. Evitar configurar obligatorios sobre personas reales durante QA; usar empresa/registro explícitamente de prueba. Comprobar claro/oscuro y permiso de lectura.

### Tarea 6: Listado y formulario fieles a las referencias

**Files:** modificar HrPage.tsx, EmployeesManagement.tsx, EmployeeCreatePage.tsx, EmployeeDetailPage.tsx y hrService.ts; crear EmployeeForm.tsx, EmployeeDocumentsPanel.tsx, EmployeePicker.tsx y hr.css. Sustituir EmployeeIdentityFields solo si deja de ser necesario, sin mantener dos formularios paralelos.

**Contratos:**

```ts
type DocumentSelection = { typeId: string; file: File }
createEmployeeWithDocuments(payload: EmployeePayload, documents: DocumentSelection[], requestId: string): Promise<Employee>
type EmployeeFormProps = { value: EmployeePayload; onChange: (value: EmployeePayload) => void; disabled: boolean }
type EmployeeDocumentsPanelProps = { employeeId?: string; selections: DocumentSelection[]; onChange: (files: DocumentSelection[]) => void; disabled: boolean }
```

- [ ] Tomar captura actual y compararla con ambas referencias antes de tocar composición. Fijar diferencias: título incorrecto, tarjeta de filtro colapsada, salario/código en columnas separadas, fotografía sustituyendo documentos, acciones y espacios.
- [ ] Listado: cabecera “Empleados” y alta naranja; cuatro indicadores con iconos; barra visible buscar/estado/puesto/sucursal/limpiar. Tabla compacta: selección, empleado con foto+nombre+code/email, puesto, sucursal, estado, ingreso y acciones. Mostrar selección útil para descarga autorizada de fichas; no baja masiva implícita. Tamaños 8/16/32 y Pagination existente con datos del servidor.
- [ ] Formulario compartido: tarjeta Datos personales y tarjeta Puesto y condiciones, izquierda 60%; Documentos derecha 40%; responsive apilado bajo 1024px sin tarjetas vacías gigantes. Labels, campos de referencia adaptados a Guatemala, foto compacta y supervisor remoto. Mantener formulario de edición y sus reglas IGSS/transferencia. Mostrar obligatoriedad real de requisitos, no imponer todos los campos nuevos.
- [ ] Panel documental: filas con icono, requisito/instrucciones, badge cargado/pendiente/opcional y acciones; dropzone compatible PDF/JPG/PNG. Reutilizar primitivas de carga existentes, sin utilizar el validador de imágenes para PDF. Carga mediante selector y arrastre, reemplazo, archivo/restore con permisos y errores por archivo.
- [ ] Alta multipart con Idempotency-Key estable para el mismo envío. Si cambia payload/archivo tras un conflicto, generar nueva clave. Mantener selections al fallar. Validar tipos obligatorios vigente en servidor; 409 refresca tipos y marca faltantes sin limpiar campos. Botones deshabilitados durante envío y estado visual real, no porcentajes simulados.
- [ ] Probar alta con política vacía y otra con obligatorios, error de archivo y reintento. Verificar que refrescar detalle conserva datos/documentos. No usar identificaciones de personas reales para archivos de QA.
- [ ] Capturas a 1536px claro/oscuro y móvil; ajustar hr.css hasta reproducir densidad y jerarquía de las imágenes sin modificar componentes globales para otros módulos.

### Tarea 7: Detalle, resumen rápido y registros recientes

**Files:** modificar EmployeeDetailPage.tsx, EmployeeSummary.tsx, EmployeeAttendance.tsx y AdvancesManagement.tsx; crear EmployeeQuickSummary.tsx, EmployeeRecentRecords.tsx, EmployeeHistory.tsx y EmployeeRecordExport.ts; actualizar hrService.ts.

- [ ] Comparar captura actual con `10-employee-detail-{dark,light}.png`. Fijar expectativas: foto en cabecera; datos label/value horizontales; tercera tarjeta de métricas, no una lista de compensación; tres paneles recientes debajo; pestañas subrayadas con iconos.
- [ ] Cabecera con foto grande, nombre+estado, código/departamento/sucursal, Editar, Descargar ficha y correo. Sin correo, acción deshabilitada con explicación. `mailto:` no envía automáticamente. Reutilizar los helpers PDF existentes de forma dinámica; exportar solo datos autorizados y nunca adjuntos privados automáticamente.
- [ ] Pestañas Resumen/Asistencia/Anticipos/Historial/Documentos según permisos; primitivas Radix con línea naranja, sin estilos segmentados. Formulario compartido para editar, sin duplicar schemas ni perder identidad del empleado.
- [ ] Resumen: tarjetas personales/laborales con links de edición, métricas de overview y enlaces a pestañas; recientes asistencia/anticipos/historial con filas reales y vacíos explícitos. Renderizar solo consultas autorizadas; un error de una tarjeta no debe vaciar las demás.
- [ ] Historial paginado, tipo de evento y autor; mostrar “El historial empezó a registrarse con esta actualización” para empleados previos. Anticipos conserva confirmaciones, contabilización y destinatario fijo en expediente. Su selector global y asistencia utilizan employee-directory para no exigir acceso al salario.
- [ ] Verificar edición, registros, filtros de mes, historial, documentos y ficha descargable en ambos temas; vínculos vencidos vuelven a pedir acceso autorizado. Comprobar cambios de empresa/sucursal limpian las consultas del expediente previo.

### Tarea 8: Verificación completa y entrega

**Files:** pruebas nuevas de tareas anteriores, reporte `docs/superpowers/verification/2026-10-05-hr-expediente.md` y capturas en `/tmp` o directorio de evidencias autorizado.

- [ ] Ejecutar pruebas específicas y `npm test` en backend; `prisma validate`; diff de migración sin destrucción.
- [ ] Ejecutar `npm run test:modules`, eslint de archivos modificados, `npm run build` y `npx tsc --noEmit -p tsconfig.app.json` en frontend. Registrar los errores generales preexistentes por separado, no afirmar que TypeScript completo pasa si falla.
- [ ] QA con el navegador: listado, filtros, paginación, alta, documentos requeridos, edición, detalle, descarga, historial, asistencia y anticipos. No ejecutar pagos/anticipos reales para probar UI; esos efectos se cubren con pruebas del backend o datos sintéticos autorizados.
- [ ] QA de seguridad: acceso por usuario sin permiso, otra empresa/sucursal, URLs temporales expiradas, bucket público, tipos falsificados y restauración concurrente. No publicar un archivo de identidad real en ningún momento.
- [ ] Revisión independiente de código y de cobertura de la especificación; corregir fallos importantes antes de declarar entrega.
- [ ] Guardar capturas finales comparables en claro/oscuro y viewport móvil. Restaurar tema original y cerrar pestañas temporales. Documentar limitaciones comprobadas, permisos nuevos y ubicación de la configuración.
- [ ] Entregar resultado con evidencia visual y verificaciones; no hacer commit/push sin autorización del usuario.

## Autorrevisión del plan

Cobertura: composición visual (6–7), documentos configurables (1–3 y 5), privacidad/storage (2–3), modelos y migración (1), idempotencia/recuperación (3 y 6), historial/indicadores/búsquedas seguras (4 y 7), fidelidad y pruebas (8).

Los cinco riesgos de Review Focus tienen una prueba asignada. No hay subsistemas de nómina, mensajería o desempeño nuevos. El plan conserva los cambios existentes y no requiere bibliotecas nuevas.
