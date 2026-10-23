# Integración Infile FEL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task, según el método elegido por el usuario. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Certificar y ajustar documentos FEL mediante Infile por empresa/sucursal, con pruebas aisladas, credenciales protegidas y recuperación sin duplicar operaciones comerciales.

**Architecture:** Adaptador Infile unificado en el backend existente; operación fiscal y outbox durables en PostgreSQL. Confirmación comercial, transporte fiscal y generación PDF son procesos separados, enlazados por snapshots inmutables e identificadores persistentes.

**Tech Stack:** Node.js 22 observado localmente, Express 5, Prisma 6/PostgreSQL, Decimal de Prisma, crypto/fetch nativos, XML DOM y libxml2 aislado; React/TypeScript y componentes Auna actuales. Verificar runtime real de despliegue en Task 0.

**Spec:** `../specs/2026-10-23-infile-design.md`. Leer completo antes de ejecutar. Documento propuesto, pendiente de aprobación; no es autorización para certificar, instalar ni desplegar.

## Global Constraints

- Node.js/Express/Prisma/PostgreSQL actuales; cola PostgreSQL, sin Redis, microservicio PHP/Python ni SDK de comunidad como dependencia de producción.
- `FISCAL_ALLOW_PRODUCTION=false` por defecto. TEST y PRODUCTION aislados por empresa y evidencia. No activar producción por guardar llaves o poner `fel_enabled=true`.
- Cero HTTP, PDF o subida de archivos externos dentro de la transacción comercial. Un reintento fiscal no mueve caja/stock/contabilidad comercial.
- Credenciales fuera de SystemSetting y frontend: AES-256-GCM, nonce 12 bytes, tag 16 bytes, clave 32 bytes y AAD de empresa/conector/entorno/versión. Keyring fuera de DB; logs saneados y auditoría conservada.
- XML máximo 2 MiB; respuesta HTTP máximo 4 MiB; 500 líneas, profundidad 64, 50.000 nodos; child 128 MiB/5 s; HTTP 20 s total. TLS obligatorio y endpoints exactos controlados por operador, sin redirects ni destinos internos.
- No declarar soporte sin G0 y casos del perfil aprobados. Primera versión: GTQ, FACT/FPEQ y ajustes NCRE/anulación cuando el perfil correspondiente esté confirmado; crédito sujeto a regla de tipo aprobada. No CAFE implícito.
- UNKNOWN nunca se reenvía por un temporizador ni con una clave nueva. Identificador y XML estables según garantías documentadas de Infile.
- Conservar comprobantes internos históricos, facturas externas y solicitudes legacy. Activación no procesa el histórico automáticamente. No asumir impuestos actuales para ventas viejas.
- No modificar los servidores Odoo ni sus logs; referencias locales no son dependencias ejecutables. Revisar licencias antes de reutilizar código.
- Checkouts actuales muy modificados: revisar estado al comenzar y preservar todo cambio ajeno. Aislamiento/worktree según skill y dependencias reales, no reset, migraciones antiguas editadas, commits amplios ni despliegue automático. Checkpoints por tarea; commits selectivos solo si se autorizan.

## Review Focus

1. Infile certifica y cae el worker antes de guardar: misma operación queda UNKNOWN y se recupera, nunca vuelve a cobrar ni cambia de identificador. Task 4.
2. Dos devoluciones concurrentes o dos workers intentan ajustar el mismo original: reservas/uniqueness/fencing impiden exceder importes y duplicar notas. Task 8.
3. Rotación de clave/NIT/sucursal mientras hay trabajos y respuestas tardías: cada operación conserva su contexto, los permisos y la cuenta correctos. Tasks 1, 4 y 6.
4. Certificación correcta y storage/PDF caído: se conserva evidencia y se reintenta solo materialización; el checkout sigue confirmado. Tasks 4 y 7.
5. Activar producción con pruebas antiguas, entorno ambiguo o cola histórica: habilitación falla y no se emite ningún documento por accidente. Tasks 0, 5 y 9.

## Estructura y decisiones de interfaz

Raíz backend `B=/home/DiegoPatzan/Documents/CODE/Auna/deposito-backend`; frontend `F=/home/DiegoPatzan/Documents/CODE/Auna/deposito-frontend`. Los paths siguientes son relativos a B salvo prefijo `F/`. No repurponer variables de entorno HOME/CODEX_HOME al ejecutar comandos.

`src/modules/fiscal/` concentra `permissions.js`, `scope.js`, `validation.js`, `connectorService.js`, `credentials.js`, `profiles.js`, `snapshots.js`, `operations.js`, `worker.js`, `reconciliation.js`, `adjustments.js`, `artifacts.js`, `storage.js`, `presentation.js`, `routes.js`; `infile/` contiene `contract.js`, `transport.js`, `xml.js`, `response.js`, `validationChild.js`. Crear archivos al implementar su responsabilidad, no scaffolding vacío por adelantado. El módulo sirve Configuración y Ventas; no crea un módulo comercial independiente que el cliente tenga que licenciar/activar.

Tipos de frontera (objetos JSON, dinero y cantidades siempre strings):

- `FiscalScope={companyId,branchId,actorId,permissions,isAdmin}`; contexto validado contra la sesión, no confiado por recibir headers.
- `ConnectorDTO={id,provider,environment,state,revision,credentialStatus,capabilities,blockingReasons,lastTestAt}`; nunca claves ni ciphertext.
- `FrozenFiscalInput={version:1,companyId,branchId,saleId?,source,issuedAt,connectorVersionId,contractId,profile,emitter,receiver,lines,totals,original?,renderProfiles}`. `lines` conserva ID origen, tipo bien/servicio, unidad SAT, cantidades/precio/descuento/base/impuestos/totales exactos; `original` solo para ajuste/anulación.
- `OperationDTO={id,action,environment,state,documentId?,errorCode?,retryAllowed,reconcileAllowed,updatedAt}`. Datos de documento visibles vienen de SaleDte, no de flags del navegador.
- `InfileOutcome={kind:'accepted',authorization,series,number,certifiedAt,certifiedXml:Buffer}|{kind:'rejected',code,message}|{kind:'unknown',code}`. Un error no clasificado de red/JSON se considera unknown. `accepted` exige cotejo completo, no solo HTTP 200.
- `prepareFiscalSnapshot(tx,scope,sale,{connectorVersion,establishment,receiver?}): FrozenFiscalInput`; `enqueueFiscalOperation(tx,scope,{action,sourceKey,input,parentDocumentId?,returnId?}): OperationDTO`.
- `sendInfile({contract,credentials,identifier,xml,signal}): Promise<InfileOutcome>`; no acceso Prisma/stock en el adaptador.
- `processNextFiscalOperation(db,{workerId,transport,clock,storage}): Promise<'idle'|'blocked'|'unknown'|'rejected'|'accepted'|'done'>`; dependencias inyectables para simulador y crash tests.
- `reconcileFiscalOperation(db,scope,operationId,{expectedVersion,idempotencyKey,evidence?}): Promise<OperationDTO>`; sin escape para forzar una segunda emisión.

## Orden y puertas

Tasks 1–8 pueden avanzar localmente con simulador cuando el diseño se apruebe. No permiten tráfico a un certificador sin contrato/entorno permitido; los fixtures locales se marcan como no oficiales. Task 9 depende de G0 y cuenta TEST. Producción depende además de evidencia administrativa, revisión fiscal y aceptación explícita del piloto real. No prometer fecha de aprobación de Infile.

### Task 0: Cerrar contrato y herramientas sin emitir nada

**Files:** Create `docs/fiscal/infile-contract.md`, `docs/fiscal/infile-acceptance-matrix.md`, `tests/fixtures/fiscal/README.md`; luego `src/modules/fiscal/infile/contract.js` y `tests/fiscal.contract.test.js`. Modify `package.json`/lockfile solo durante implementación aprobada.

**Interfaces:** `contractFor(environment,policy): {id,verified,endpoint,identifierPolicy,responsePolicy,schemas,allowedProfiles}`. Contrato incompleto expone `verified:false` y no habilita HTTP real. Política de identificador contiene longitud/charset/alcance/ventana documentados, no un TTL supuesto.

- [ ] Registrar evidencia actual y todos los pendientes G0 de la spec, con fuente, fecha, propietario y condición de desbloqueo. No usar documentos de autorización de certificadores SAT como si fueran requisitos de un ERP emisor.
- [ ] RED: `contractBlocksUnverifiedEndpointAndAmbiguousTestAccount` afirma que sin endpoint/aislamiento/recuperación confirmados no hay capacidad de envío, aunque existan cuatro claves.
- [ ] GREEN: implementar contrato cerrado de Infile unificado con manifest de versiones; conservar URL observada solo como referencia no habilitada hasta G0.
- [ ] Seleccionar y fijar dependencia XML después de revisar avisos. Candidato observado: `@xmldom/xmldom@0.9.12`; no instalar `xmldom` antiguo ni paquete archivado `saxes`. Documentar versión libxml2 del hosting, actualización de seguridad, invocación aislada y bundle XSD local con hashes. Si falta, capacidad bloqueada.
- [ ] Verificar `node --require ./tests/setup-env.js --test tests/fiscal.contract.test.js`: casos negativos y positivos de política con simulador, sin red. Revisar diff y guardar checkpoint de decisiones. Para G0 real, contrastar posteriormente con Infile y actualizar evidencia, no marcarlo cumplido por los mocks.

### Task 1: Persistencia, permisos y bóveda de conexión

**Files:** Modify `prisma/schema.prisma`, `prisma/seed.js`, `src/config/permissionDeps.js`, `src/modules/config/routes.js`; Create una migración nueva con fecha real de implementación, `src/modules/fiscal/{permissions,scope,validation,credentials,connectorService,routes}.js`; Test `tests/fiscal.credentials.test.js`, `tests/fiscal.connectors.test.js`, `tests/fiscal.migration.dev.e2e.js`.

**Interfaces:** `saveInfileConnection(db,scope,{environment,expectedVersion,idempotencyKey,credentials?,profile?,establishments?}): ConnectorDTO`; `readInfileConnection(db,scope,environment): ConnectorDTO`; `sealCredentials(context,values,keyring): envelope`; `openCredentials(context,envelope,keyring): values`. Envelope `{keyId,iv,tag,ciphertext}`; cada versión es inmutable y las operaciones referencian su ID.

- [ ] RED: round-trip cifra; nonce distinto para mismo texto; AAD/empresa/entorno/versión/keyId alterados rechazan; clave faltante no cae a plaintext; GET, historial, logs y errores no contienen claves. Guardado sin campos conserva; vacío rechaza; edición obsoleta devuelve 409.
- [ ] RED PostgreSQL desechable: FKs de empresa/sucursal/conector-versión/origen, unicidad de proveedor/entorno y operaciones, rechazo de deletes de evidencia; roles `anon`/`authenticated` sin acceso directo a tablas fiscales privadas. Reutilizar claves compuestas existentes, no FK simple que admita cruce de empresa.
- [ ] GREEN: crear los seis modelos de spec. `FiscalOperation` fija `connector_version_id`, `environment`, `action`, origen, snapshot/hash, `identifier`, XML exacto privado, estados/lease/revisión e idempotency keys. `FiscalAttempt` guarda inbox permitido de respuesta y metadatos, nunca headers de autenticación; `FiscalEvent` append-only. Agregar `Sale.fiscal_snapshot`, referencias nuevas a SaleDte/DocumentSnapshot y constraints/índices indicados en spec. Preparar preflight de duplicados históricos antes de índices nuevos, sin aplicar a DB conectada todavía.
- [ ] GREEN: permisos `fiscal.view/manage/test/activate/retry/cancel/download`, escoping real y rutas `/api/config/connectors`. Sanitizar DTO mediante whitelist explícita, no serializar modelos Prisma enteros. Limitar payload/rate, rechazar URLs/props no permitidos. No tocar settings genéricos para almacenar secretos.
- [ ] Verificar unitarias y migración en PostgreSQL efímero autorizado. `ENV_FILE` de test dedicado; nunca ejecutar fixtures con el `.env` productivo por defecto. Checkpoint de diff/schema; no migrar ni sembrar permisos contra base compartida sin paso de despliegue acordado.

### Task 2: Perfil fiscal y snapshot exacto antes de enviar

**Files:** Create `src/modules/fiscal/{profiles,snapshots}.js`; Modify integración de snapshot en `src/modules/sales/{controller,manualSales}.js` solo en los puntos de confirmación; Test `tests/fiscal.snapshots.test.js`, `tests/fiscal.profiles.test.js`.

**Interfaces:** `resolveFiscalProfile(connectorVersion,{sale,products,units}): profile`; `prepareFiscalSnapshot` de interfaces; `validateFiscalInput(input): {valid,fieldErrors}`. Perfil versionado incluye régimen, tipos habilitados, reglas fiscales confirmadas, `unitMap`, `productTaxMap` y defaults de categoría explícitamente aprobados, no inferencia por nombre. Mapeos se gestionan dentro de la versión de configuración, con validación de IDs contra empresa, límite 128 KiB y revisiones; si necesita más, cambiar almacenamiento en una tarea medida, no truncarlo.

- [ ] RED: una venta fixture de total 112.00 y tasa fixture 0.12 incluida produce base 100.00 e impuesto 12.00, sin usar Number. Esa tasa es de la fixture, no la regla de todos los clientes. Igualdad exacta entre suma de líneas, impuestos, descuentos y total de venta.
- [ ] RED: servicio, fracciones/presentaciones v1/v2, promociones/descuento global, categoría exenta y régimen pequeño usan el perfil correcto. Unidad sin mapeo, impuesto específico no soportado, moneda distinta, receptor incompleto y crédito sin política bloquean; no caen a UNI/GEN/FACT por defecto.
- [ ] RED: editar producto/precios/impuestos/empresa después de confirmar no cambia snapshot; falta de datos legacy exige revisión y no reconstrucción automática con precios/tasas actuales. Empresa/sucursal o consumidor final distinto no se acepta por solo cambiar el header.
- [ ] GREEN: construir snapshot con datos comerciales congelados y perfil confirmado, fuente temporal `issuedAt` fija con offset Guatemala. Reparto de descuentos y redondeos según G0 y suma conservada; no parche de centavos sin regla. Copiar perfil visual a `renderProfiles` sin generar PDF. Guardar snapshot en la misma confirmación si hay preparación fiscal; no hacer HTTP ni storage externo.
- [ ] Verificar `node --require ./tests/setup-env.js --test tests/fiscal.snapshots.test.js tests/fiscal.profiles.test.js` y regresiones de confirmación manual/POS. Antes de producción, sustituir fixtures únicamente por casos contrastados en G0; perfiles no contrastados quedan deshabilitados.

### Task 3: XML y transporte unificado con límites reales

**Files:** Create `src/modules/fiscal/infile/{xml,response,transport,validationChild}.js`, `src/modules/fiscal/infile/schemas/manifest.json` y bundle local verificado cuando esté disponible; Test `tests/fiscal.xml.test.js`, `tests/fiscal.transport.test.js`, `tests/fiscal.xml-runtime.dev.e2e.js`; fixtures sintéticas y oficiales anonimizadas separadas.

**Interfaces:** `buildIssueXml(input): Buffer`, `buildCancelXml(input): Buffer`, `buildCreditNoteXml(input): Buffer`; `validateAndMatchXml(xml,{kind,input,contract}): Promise<matchedMetadata>`; `sendInfile` de interfaces. Builder DOM escapa datos como nodos/atributos. Validación/extracción trabaja en child sin credenciales, con namespaces/rutas únicos y salida mínima.

- [ ] RED: cabeceras exactas de Infile unificado y `Content-Type: application/xml`; misma operación envía mismo identificador y mismos bytes. G0 no verificado impide contacto real incluso si alguien intenta llamar el adaptador directamente.
- [ ] RED: `resultado:true` sin UUID/XML/serie/número/fecha, autorización o emisor/total divergentes, Base64 inválido, números de respuesta fuera de precisión segura, JSON malformado, HTTP 200 de rechazo y 5xx no se convierten en certificado. Solo rechazo definitivo reconocido es `rejected`; ambiguos son `unknown`.
- [ ] RED: XXE local/red, entidades, namespace spoofing, nodos protegidos duplicados, XInclude, UTF-8 inválido, exceso de bytes/profundidad/nodos, proceso colgado, XSD ausente y schemas remotos fallan cerrados sin salida de secretos ni acceso a red/archivos externos. Usar canarios controlados, no archivos reales del usuario.
- [ ] GREEN: HTTP nativo sin redirects, HTTPS validado, timeout total 20 s y lectura streaming acotada. Endpoint/política y conexión DNS controlados; no fetch de PDF arbitrario. Validar datos de respuesta y XML con contrato antes de outcome accepted. Mapear errores a códigos propios, sin devolver cuerpo/traza ni registrar credenciales.
- [ ] GREEN: proceso XML `--max-old-space-size=128`, timeout 5 s; xmllint `--noout --nonet --schema <bundle-local> -`, sin `--noent`, `--loaddtd`, `--xinclude`, `--huge` ni shell. Bloquear DTD antes; entorno/catálogos/archivos permitidos controlados. Verificar aislamiento en runtime, no afirmar que `--nonet` basta.
- [ ] Verificar unitarias con HTTP local simulado y runtime XML real; cero llamadas a Infile. Assert de hijo sin variables fiscales/DB, y que contenido inválido no sale por logs. Checkpoint dependencias y evidencia del validador.

### Task 4: Entrega durable, inbox y recuperación

**Files:** Create `src/modules/fiscal/{operations,worker,reconciliation,storage}.js`, `scripts/fiscal-worker.js`; Modify `package.json` para `fiscal:worker`; Test `tests/fiscal.delivery.test.js`, `tests/fiscal.delivery.dev.e2e.js`.

**Interfaces:** `enqueueFiscalOperation`, `processNextFiscalOperation`, `reconcileFiscalOperation` de interfaces; `persistAcceptedOutcome(tx,operation,attempt,outcome): documentProjection`; `getRecoveryAction(contract,operation): 'QUERY'|'REPLAY_SAME'|'MANUAL'`. `REPLAY_SAME` exige garantía vigente G0, no es valor por defecto. Inbox conserva campos permitidos + XML exacto y huella; no arbitrary headers/payload de error.

- [ ] RED: dos workers y doble petición producen una operación/identificador; ambos no pueden finalizar con lease diferente. Un crash en SENDING, timeout, 5xx o respuesta perdida da UNKNOWN; reclamación de lease expirado no vuelve a QUEUED. HTTP interceptado tras aceptación seguido de fallo de DB/storage no permite otro POST nuevo.
- [ ] RED: aceptación durable seguida de error PDF/storage se materializa después sin certificar otra vez; intento repetido devuelve mismo documento. Al pausar o rotar, no se envía con otra cuenta/versión. Consulta de recuperación tras pausa solo con permiso y cuenta histórica autorizada.
- [ ] GREEN: XML e identificador persistidos antes de SENDING; construir XML desde snapshot fijo fuera del commit comercial. Claim `FOR UPDATE SKIP LOCKED`, lease 120 s, heartbeat 15 s y fencing por token/revisión; máximo global 2 y una operación en vuelo por conector/empresa. NIT/entorno/empresa en todas las búsquedas.
- [ ] GREEN: persistir inbox, certificar/materializar en paso idempotente; estados `QUEUED/SENDING/UNKNOWN/ACCEPTED/DONE/REJECTED/BLOCKED`. Auditoría interna sin cuerpo sensible. Pasos locales/consultas seguras usan 30 s/2 min/10 min y máximo tres intentos; no aplicar ese scheduler para reenviar UNKNOWN.
- [ ] GREEN: recuperación por contrato confirmado o revisión con evidencia verificable y acción autorizada. Sin contrato de recuperación, no exponer un botón de reemisión ni promover a éxito por una afirmación manual sin documento cotejado. Antes de producción debe existir un procedimiento recuperable validado, automático o manual.
- [ ] Verificar unitarias y concurrencia/crash tests en PostgreSQL desechable con servidor HTTP simulado. Assert antes/después que pagos, stock, ventas y asientos comerciales no cambian por llamadas repetidas al worker. Checkpoint de estados/índices y métricas de cola.

### Task 5: Conectar solicitudes actuales, POS y estados comerciales

**Files:** Modify `src/modules/sales/{fiscalRequests,commercialState,externalInvoices,controller,manualSales,sales.routes}.js`, `src/modules/sales/application.js` si el punto común lo permite; Create `src/modules/fiscal/presentation.js`; Modify `F/src/types/sale.ts`, `F/src/modules/sales/{commercialPresentation,SaleInvoicePage}.tsx` (el archivo commercialPresentation es `.ts`), `F/src/modules/sales/components/{SaleFiscalAction,SaleDetailContent,SalesStatusTable}.tsx`, `F/src/services/saleService.ts`; Test `tests/fiscal.sales.test.js`, `tests/sales.fiscal-requests.dev.e2e.js`, `F/tests/infile-sale-states.test.cjs`.

**Interfaces:** `fiscalCapabilities(db,scope,sale): {state,request,reconcile,cancel,download,blockingReasons}`; ampliar `FiscalState` con `QUEUED/SENDING/UNKNOWN/REJECTED/CERTIFIED/CANCELLED` conservando lectura de AUTHORIZED y RECORDED_EXTERNAL legacy. Mantener UNRECORDED/PENDING_CONNECTOR/REVIEW_REQUIRED/DISABLED. `requestSaleInvoice` conserva su contrato actual y ahora retorna proyección con operación si corresponde.

- [ ] RED: POS crea venta, pago y outbox en un solo commit; si rollback, no hay trabajo huérfano. Si Infile tarda 20 s, checkout no espera esos 20 s. Falta de datos fiscales requerida se detecta antes de commit, mientras caída externa no vuelve a fallar el cobro ya registrado.
- [ ] RED: confirmación de borrador/cotización/Agenda no factura dos veces ni cambia reglas de anticipos. Solicitud explícita de venta confirmada funciona con permisos actuales; GET/listados no crean documentos. `PENDING_CONNECTOR` histórico no se drena al activar ni aparece como certificado.
- [ ] GREEN: llamar prepare/enqueue en la transacción existente; separar intención FEL de readiness. No cambiar stock/payment ni sustituir contratos de checkout idempotente. Presentación usa documentos válidos de entorno real y autoridad del servidor, nunca longitud de `sale_dtes` como único criterio.
- [ ] GREEN UI: estado compacto; «Consultar resultado» para UNKNOWN; «Revisar datos» en rechazo; «Descargar factura» solo certificado. Polling visible cada 2 s máximo 60 s, abort y verificación de tenant/sesión; conservar venta y navegación del POS. No box invasivo de procesando ni método de pago preseleccionado por esta feature.
- [ ] Verificar backend de ventas/checkout/fiscal + frontend de estados/permisos y test de cambio de tenant durante polling. Benchmark en fixture controlada mide overhead de encolado p95 ≤ 300 ms y solicitud ≤ 500 ms; registrar valores reales y no confundir tiempo Infile con tiempo checkout.

### Task 6: Configuración guiada, pruebas y activación controlada

**Files:** Create `F/src/modules/config/connectors/{api,types,useConnectorScope,ConnectorSettingsLayout,InfileConnection,InfileTests,InfileActivity,FiscalMappings}.tsx` (helpers no visuales `.ts`), `F/src/modules/config/pages/ConnectorsPage.tsx`; Modify `F/src/modules/config/{manifest,settingsModel}.ts`, `F/src/modules/config/pages/ConfigManagement.tsx`, `F/src/modules/config/components/FiscalSettingsSection.tsx`, `F/src/App.tsx`; Extend `src/modules/fiscal/{connectorService,routes,profiles}.js`; Test `tests/fiscal.activation.test.js`, `F/tests/infile-connectors.test.cjs`.

**Interfaces:** `validateConnector`, `runTestCase`, `activateProduction`, `pauseConnector` commands with scope/revision/key; evidence targets connectorVersionId+profile+establishment and environment. TEST cases create only TEST FiscalOperation with synthetic snapshot, no Sale/SaleDte/cash/stock rows.

- [ ] RED: guardar cuatro credenciales no activa; «Validar configuración» no envía HTTP. TEST con cuenta/URL ambiguas queda bloqueado. Un usuario sin activate no puede habilitar conector desde settings genéricos ni otra ruta. Casos antiguos u otra empresa/versión no satisfacen el checklist.
- [ ] GREEN: Configuración → Conectores → Infile con sidebar; cuatro campos diferenciados, estados y botones contextuales; secretos write-only, revisión optimista, confirmaciones Auna. Personalizado visible deshabilitado, sin URL libre. Añadir mapeos por sucursal/unidad/categoría con selección de IDs de la empresa, revisión y límites; los pendientes se explican como campos concretos.
- [ ] GREEN: casos de TEST sintetizados, código de resultado saneado, historial auditado y evidencia de revisión. Activación exige G0, runtime/keyring/storage/worker, establecimiento, perfiles completos, suite aprobada y evidencia administrativa local; no simular aprobación remota. `FISCAL_ALLOW_PRODUCTION` permanece control del operador, no del formulario.
- [ ] Verificar tests de permisos, claves no presentes en snapshots DOM/red/historial, cancelación y cambio de empresa al guardar. Verificación visual de layout, móvil, teclado y alertas con browser permitido; si no hay acceso, declarar limitación, no usar capturas inventadas.

### Task 7: Factura/ticket reales en el motor existente

**Files:** Create `src/modules/fiscal/artifacts.js`; Modify `src/modules/sales/documents/{snapshot,data,artifacts,worker,storage}.js`, `src/modules/config/documentTemplates/{routes,service,render,contract}.js`, `src/modules/config/hardware/printing/{saleTicketRead,service,sources}.js`; Modify `F/src/modules/config/documentTemplates/{TemplateEditor,TemplateBases}.tsx`, `F/src/modules/config/pages/DocumentTemplatesPage.tsx`, `F/src/modules/config/hardware/printing/{saleDocuments,flow}.ts`, `F/src/modules/sales/SaleInvoicePage.tsx`; Test `tests/fiscal.artifacts.test.js`, `tests/fiscal.printing.test.js`, `F/tests/infile-documents.test.cjs`.

**Interfaces:** `prepareCertifiedSnapshot(db,scope,{documentId}): DocumentSnapshot`; `resolveDocumentPurpose(db,scope,{saleId,documentId?}): {purpose,documentId?,state}`; `requestCertifiedArtifact` usa requestPreparedArtifact actual. Distintas facturas/notas de la misma venta tienen snapshots propios por fiscal_document_id.

- [ ] RED: no hay PDF fiscal real para TEST/PENDING/UNKNOWN/REJECTED; muestra requiere watermark. Otro tenant no descarga XML/PDF. PDF fallido + retry no llama transporte. Publicar nueva plantilla no altera reimpresión; activar FEL no convierte comprobantes viejos.
- [ ] GREEN: sustituir bloqueos absolutos FISCAL_CONNECTOR_UNAVAILABLE por capacidad servidor + documento certificado auténtico/entorno. Renderizar datos protegidos del snapshot verificado; mantener validación visual de tres casos existente. FEL ordinario en producción preparada, interno histórico accesible; sin producción, interno operativo y FEL muestras claramente diferenciadas.
- [ ] GREEN: ticket 80 mm monocromo con logo y Clásico FEL Carta; QR/link solo desde contrato oficial confirmado, no URL recibida libremente. Descarga XML binaria autorizada, privada y con hash. Estado de certificado independiente del render; no rebajar a interno silenciosamente por fallar PDF.
- [ ] GREEN: autoimpresión fiscal solo tras certificado y una vez por intención identificada; cambios de estado/polling/retry no duplican impresión. Antes de certificado, UI avisa pendiente sin falso ticket fiscal. Reimpresiones explícitas se auditan y no afirman impresión física confirmada por el navegador.
- [ ] Verificar render/preview/export en Carta/A4/80 mm, múltiples páginas, caracteres y nombres largos; abrir PDF generado y comparar con plantillas aprobadas. No es trabajo terminado con solo tests de texto o screenshot del formulario.

### Task 8: Anulaciones y notas de crédito vinculadas a devoluciones

**Files:** Create `src/modules/fiscal/adjustments.js`; Extend `src/modules/fiscal/{operations,routes,presentation}.js`; Modify `src/modules/returns/{application,presentation}.js`, `src/modules/sales/sales.routes.js`; Add `F/src/modules/sales/components/FiscalDocumentActions.tsx` y acciones contextuales en detalle de devolución real; Test `tests/fiscal.adjustments.test.js`, `tests/fiscal.adjustments.dev.e2e.js`, `F/tests/infile-adjustments.test.cjs`.

**Interfaces:** `requestFiscalCancellation(db,scope,documentId,{reason,expectedVersion,idempotencyKey}): OperationDTO`; `prepareReturnCreditNote(tx,scope,{returnId,originalDocumentId}): OperationDTO`. Reusar buildCancelXml/buildCreditNoteXml y worker; no otro pipeline HTTP. Endpoint devuelve 202 y estado, no éxito fiscal prematuro.

- [ ] RED: dos cancelaciones mismo documento se unen; motivo ausente o documento ajeno rechaza. Rechazo de anulación mantiene original certificado, UNKNOWN no se etiqueta anulado; cancelación fiscal no cancela venta ni reembolsa por sí sola.
- [ ] RED: devoluciones concurrentes no exceden valor/cantidad original considerando NCRE certificadas y pendientes. Worker duplicado no emite segunda nota ni repite reembolso/stock. Original pendiente hace esperar al ajuste. Una devolución parcial no produce anulación total.
- [ ] GREEN: reservar presupuesto fiscal bajo lock del original, FK/unique de origen y acumulación Decimal. ISSUE original y ajustes conservan XML/identificadores/snapshots distintos. Tipos/perfiles/plazos de G0 se aplican; sin soporte queda BLOCKED explícito, no un documento interno disfrazado de nota.
- [ ] GREEN: integración solo en resolución comercial efectiva y una vez, no en lectura ni cada cambio de estado. Un perfil con devoluciones no pasa producción hasta su ajuste validado; rechazos requieren acción auditada sin repetir efectos comerciales.
- [ ] Verificar ciclo comercial+fiscal en PostgreSQL de pruebas con dos devoluciones y dos workers concurrentes; comparar saldo/refund/stock/contabilidad antes/después de todos los reintentos. Revisar flujos refund/exchange/store-credit actuales: tipo fiscal no se deduce solo de que exista Return.

### Task 9: Homologación TEST, despliegue y piloto productivo

**Files:** Create `docs/fiscal/infile-runbook.md`, `docs/fiscal/infile-production-checklist.md`, `docs/fiscal/infile-performance.md`, `scripts/check-fiscal-readiness.js`, `scripts/prepare-fiscal-migration.js`; Add `tests/fiscal.infile.test-environment.e2e.js`, `tests/fiscal.restore.dev.e2e.js`. Extend runbook de worker según hosting elegido; no cambiar los servidores Odoo usados como referencia.

**Interfaces:** `checkFiscalReadiness({companyId,environment}): {ready,blockers,evidenceVersion}` no emite ni certifica; CLI por defecto solo lectura y sin listar secretos. Live E2E exige `AUNA_INFILE_TESTS=approved`, entorno TEST confirmado y fixtures/credenciales específicas; ningún test automatizado permite PRODUCTION.

- [ ] RED: migrate preflight detecta duplicados legacy sin borrar; faltan claves/bundle/worker/storage/procedimiento UNKNOWN o casos del perfil y readiness es false. Restauración con datos reales copiados no dispara envíos porque salida productiva queda bloqueada.
- [ ] GREEN: ensayo de migraciones con datos representativos y usuarios sin grants; verificar CHECK/FK/índices reales, `EXPLAIN` de claim y listados; probar rollback de aplicación sin borrar evidencia. Prueba de backup/restore de DB+objetos+keyring en entorno aislado y de rotación de claves con operaciones pendientes.
- [ ] Ejecutar suites completas de B (`npm test`), F (`node --test tests/*.test.cjs`), F build y límites de módulos. Registrar errores previos separados de regresiones, no ocultarlos. Medir costo incremental y fallos simulados; no prometer una duración fija de Infile.
- [ ] Con G0 y autorización de cuenta TEST, ejecutar matriz por perfil: emisión, rechazo, CF/receptor, unidades, fracciones, descuentos, impuestos, NCRE, anulación, duplicado y recuperación de respuesta perdida; guardar evidencia mínima anonimizada. Ningún caso TEST afecta ventas/caja/stock reales.
- [ ] Registrar evidencia administrativa de Infile/SAT/empresa que corresponda a su cuenta; confirmar con el usuario alcance, costos/validez y primera operación real necesaria. No emitir Q1 ni anular automáticamente como prueba técnica de producción. Activar un piloto empresa/sucursal con observación de cola y verificación por los canales oficiales aplicables.
- [ ] Ampliar solo tras aceptación: pausa/recuperación documentadas, alertas por antigüedad de cola/UNKNOWN/rechazos/keyring, responsables y retención aprobada. No procesar retrospectivamente PENDING_CONNECTOR salvo selección explícita y revisión. Actualizar guías para el cliente con estados y acciones entendibles.

## Matriz de entrega y aprobación

| Entrega | Demostración exigida | Qué no autoriza |
| --- | --- | --- |
| Base local (0–3) | Cifrado, aislamiento y XML/simulador con límites | Contactar certificador o guardar llaves de clientes reales para probar |
| Operación recuperable (4–6) | Crash/concurrencia, POS desacoplado y UI con permisos | Marcar fixtures como facturas ni activar producción |
| Ciclo documental (7–8) | XML/PDF originales, impresión y ajustes sin duplicados | Declarar legalmente soportado un perfil no confirmado |
| TEST homologado (9) | Evidencia real de cuenta TEST y G0 | Producción automática |
| Piloto real (9, aprobación separada) | Primera operación autorizada y recuperación/operación comprobadas | Emisión masiva o histórica implícita |

## Revisión del plan y handoff

- Diseño revisado por builder independiente: no identificó preguntas adicionales necesarias para planificar; G0 permanece un bloqueo externo explícito, no «resuelto» por revisión.
- Antes de implementación, usuario aprueba diseño y plan y elige ejecución. Recomendación del autor: ejecución aquí por bloques con revisión independiente final, por la dependencia fuerte entre contratos, cola y proyección comercial; no paralelizar cambios a los mismos servicios de ventas.
- Antes de cada tarea, releer interfaces y estado real del repo. Si el contrato de Infile exige otro flujo, documento legal o garantía, actualizar diseño/plan y presentar el cambio; no improvisar una API ni activar producción para descubrirlo.
- No se implementó código de producto, instaló dependencias, modificó base o contactó servidores/certificadores al escribir este plan.
