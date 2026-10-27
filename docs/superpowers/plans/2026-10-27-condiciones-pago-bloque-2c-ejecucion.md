# Bloque 2C — Ejecución del alcance aprobado

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task. Checkbox steps track execution, not deployment.

**Goal:** Anticipo y vencimiento configurables por acuerdo, conservados desde cotización, con confirmación derivada y guardas operativas, sin duplicar cobros.
**Architecture:** snapshots opcionales y estado calculado desde Cartera existente; Decimal/Luxon; React/componentes Auna; sin dependencias nuevas.
**Spec:** `docs/superpowers/specs/2026-10-26-paquetes-productos-servicios-design.md`.
**Origen:** plan 2C aprobado explícitamente en chat. El archivo original ahora contiene siete bytes («si apro»); se preserva. Esta recuperación no amplía el alcance.

## Global Constraints

- Sin Infile, DonShot, SSH, pasarelas, pagos web, notificaciones ni ampliación de API keys.
- No aplicar migración ni generar cliente activo/reiniciar servicios por despliegue sin autorización nueva. Usar PostgreSQL/cliente temporales para aceptación.
- Política opt-in en nueva cotización o contratación directa, sin valores predeterminados de porcentaje/días ni aplicación retrospectiva. Null mantiene legacy; omisión al editar conserva; null explícito solo quita en borrador.
- Una política común para todos los bienes, paquetes y servicios del acuerdo; no política por evento/paquete. Si necesita cobros separados, cotizaciones separadas.
- Porcentaje0–100 con hasta2decimales; días0–365 enteros. Campos vacíos no equivalen a cero. Base total neto después de descuentos en moneda del documento, incluido traslado como partida real una sola vez. No contado/crédito ni deuda contable nueva.
- Congelar condiciones al enviar/aceptar; cambios comerciales mediante corrección/nueva propuesta. Conservar en cotización/pedido/venta/contratación.
- Inicio primera prestación previsto obligatorio con zona IANA; vencimiento resta días de calendario conservando hora local; `now>=dueAt` vence si queda saldo. No usar inicio de traslado.
- Confirmación derivada exige programación completa/vigente sin conflictos, anticipo efectivo suficiente y alcance sin revisión. No almacenar confirmed=true ni confundir programación/reserva/venta/pago.
- Cobertura efectiva=COMMITTED+aplicaciones actuales. No duplicar APPLIED ni volver a descontar devoluciones; crédito libre no cuenta. Solicitud de devolución exige revisión, no simula pago.
- Saldo vencido bloquea START/COMPLETE/CONFIRM_COMPLETION. Excepción puntual con permiso/motivo/hash vigente, sin alterar dinero ni omitir anticipo o programación. Cancelación nunca genera devolución automática. AUTO solo cierra horario, no prestación comercial.
- Referencia parcial=mínimo entre acordada y horarios activos; completa=primer horario real. Cancelar/liberar el primero no prorroga sin revisión. Reprogramar revisa todo el acuerdo atómicamente y conserva historial.
- Operador sin receivables.view solo ve capacidades/motivos redactados. Condición pública solo acuerdo, nunca cobros/excepciones/identidades internas. UI compacta con componentes, sin formulario modal grande ni campos numéricos estirados.
- Preservar cambios ajenos; trabajo incremental en los mismos checkouts con prerrequisitos sin confirmar, no main/master. No push/merge.

## Shared interfaces

Input=`{schemaVersion:1,depositPercent:string,balanceDaysBefore:number,referenceStartsAt:string,referenceTimezone:string}` o null; cerrado, fechas ISO con offset. Snapshot=input+`{basisTotal:string,currencyCode:string}` exclusivamente del servidor. Reference=`{startsAt,timezone}` o null (usa snapshot).

State=`{enabled,confirmation:NOT_APPLICABLE|PENDING_SCHEDULE|PENDING_DEPOSIT|REVIEW_REQUIRED|CONFIRMED,payment:NOT_APPLICABLE|PENDING|PARTIAL|PAID|OVERDUE,dueAt,reference,depositRequired,depositMissing,paid,remaining,canStart,canComplete,reasons,reviewHash}`. Monetary values exact strings; read DTO redacted without finance permission.

## Review Focus

1. Compromiso→aplicación o devolución concurrente con inicio/cierre: sin doble cobertura ni lectura vieja (3/5/8).
2. Varios eventos y clase compartida: obligación global sin afectar clientes ajenos (4/5/8).
3. DST/medianoche/reprogramar/cancelar primero: vencimiento coherente sin prórroga oculta (1/4/8).
4. Copiar/convertir/editar vía rutas alternas/API/token: no perder condiciones ni elevar permisos (2/6/8).
5. Pestaña vieja/permiso revocado/operador sin finanzas: no filtrar dinero ni reutilizar excepción (5/7/8).

### Task 1: Dominio de condiciones

**Files:** crear `src/services/eventPaymentTerms.js`, `tests/event-payment-terms.test.js`.
**Interfaces:** `parseEventPaymentTerms(raw)`; `freezeEventPaymentTerms(input,{total,currencyCode})`; `eventPaymentDueAt(snapshot,reference)`; `evaluateEventPaymentTerms({terms,reference,money,scheduling:{complete,valid},reviewRequired,now})` (state sin reviewHash).
- [ ] RED testear 100.01*33.33%=33.33; pago33.32 falta0.01; cubierto sin programación no confirma. Null legacy; cero/100, inválidos/extras/rangos/zonas. DST:9mar2026 10:00-04 America/New_York menos2días=7mar15:00Z. Vencimiento exacto, pagado no vencido, revisión prioritaria.
- [ ] `node --test tests/event-payment-terms.test.js` → FAIL función ausente; implementar Decimal/Luxon, luego PASS.
- [ ] Commit acotado y ledger de resultado.

### Task 2: Persistencia, snapshots y conservación

**Files:** schema; nueva migración `20261029120000_event_payment_terms`; `src/services/eventPaymentTermsStorage.js`; quotes/controller,index,saleDraft; orders/controller; sales/engagementSale; appointments/engagementRecords,engagements,sourceVerification. Tests `event-payment-terms.persistence.test.js`, `event-payment-terms.migration.pg.e2e.js`.
**Interfaces:** `event_payment_terms Json?` en CommercialDocument/Sale/AppointmentEngagement, `event_payment_reference Json?` en Engagement. SQL NULL legacy; shape/schema/rangos/tamaño2048bytes. `eventPaymentStorageReady(client)` y guarda preparación; cliente/DB antiguos no habilitan función ni dan500.
- [ ] RED creación/edición/preservar/quitar borrador/base neta, inyección base/moneda rechazada, inmutabilidad SENT/ACCEPTED, copia nueva y conversión preservada, contratación directa opt-in y origen cotización no sustituible. Conflicto versión vieja.
- [ ] `node --test tests/event-payment-terms.persistence.test.js` FAIL→implementar→PASS.
- [ ] E2E exige `EVENT_PAYMENT_TERMS_TEST_DATABASE_URL`, loopback/base `auna_payment_terms_test_*`, sin fallback app; historia+migración+cliente temporal, huellas todas tablas salvo columnas nuevas, checks, rollback, null existentes. PASS real, no SKIP como aceptación.
- [ ] Commit/ledger; sin migración activa.

### Task 3: Estado financiero calculado

**Files:** `appointments/engagementPaymentPolicy.js`, commercialQueries; receivables/engagementPayments si imprescindible; `tests/appointments.payment-policy-money.test.js`.
**Interfaces:** `loadEngagementPaymentState(tx,scope,e,{now,lockMoney})`; `paymentPolicyPublicState(state,{financial})`; hash SHA256 de snapshot/referencia/versión/programación/asignaciones/revisión actuales.
- [ ] RED compromiso40→APPLIED40 sigue40 no80; liberar/devolver10 deja30; solicitud revisión sin resta; fondos ajenos/libres no cuentan; venta corregida marca revisión si difiere base; legacy sin cambios.
- [ ] Test nuevo FAIL→implementar con engagementMoney→PASS; regresiones receivables.allocations,commitments y paymentMethods.engagement.
- [ ] Auditoría callers mutadores para bloqueos: Agenda→origen/quote→cliente→engagement, IDs ordenados; decisiones releen con lockCustomer y engagement, sin invertir orden de Cartera/Ventas.
- [ ] Commit/ledger.

### Task 4: Referencia al programar/mover

**Files:** `appointments/engagementPaymentReference.js`; engagementScheduling,activities,application,engagementResolution; `tests/appointments.payment-policy-scheduling.test.js`.
**Interfaces:** `reviewEngagementPaymentReferences(tx,scope,{sessionIds,bookingIds,now,acknowledgedPaymentReviewHash?})`; conflicto `PAYMENT_REFERENCE_REVIEW_REQUIRED` con resumen seguro/hash. Hash incluye contexto persistido+propuesta canónica, no IDs aleatorios de inserciones revertidas.
- [ ] RED varios paquetes/horarios anticipo único; adelantar recalcula; parcial/completo; cancelar primero revisión; rollback segundo programa incluye referencia/historia/recibo; grupo compartido no cambia otros acuerdos.
- [ ] Test nuevo FAIL→implementar creación/movimientos/cancelación/liberación con historial anterior/nuevo→PASS; timeline-scheduling,engagements,requirements-scheduling verdes.
- [ ] Commit/ledger.

### Task 5: Guardas y excepción puntual

**Files:** activities,application,domain/activities,domain/validation,autoClose,presentation,engagementPaymentPolicy; permissionDeps/seed y migración nueva; `tests/appointments.payment-policy-actions.test.js`.
**Interfaces:** `assertEngagementPaymentAction(tx,scope,{sessionId,bookingId,action,now,exception?})`; exception=`{reason,reviewHash}`. Permiso `appointments.override_payment_policy` depende attend+receivables.view, no asignado automáticamente a roles. Motivo1–500.
- [ ] RED no iniciar sin anticipo/programación; vencido bloquea inicio/cierre/confirmación comercial; excepción permiso/motivo/hash audita una sola acción, no altera dinero/reutiliza; cancelación posible; clientes clase aislados; legacy igual.
- [ ] Test FAIL→implementar server transaccional→PASS y activities,booking,auto-close,commercial-access. Booking CONFIRM no confunde estado global; sesión privada su acuerdo; compartida valida inscripción propia. AUTO conserva cierre de horario sin confirmar realización. Reversión no borra hechos, pide revisión para acciones futuras.
- [ ] Commit/ledger.

### Task 6: Documentos públicos y entradas alternativas

**Files:** B quotes/controller, customerPagesPublic, allowlist/compilador customerPages, integrations/draftDocument compatibilidad. F quoteService,QuotePresentation,QuoteDetailPage,PublicQuotePage,generateQuotePDF y lectores pedidos/ventas. Tests B quotes.event-payment-terms,customerPages.event-payment-terms; F quotes.event-payment-terms.test.cjs.
**Interfaces:** `publicEventPaymentTerms(snapshot)` solo condiciones acordadas/importes calculados/fechas/zona/moneda, sin cobros privados ni excepciones.
- [ ] RED PDF/pública/interna mismo acuerdo; aceptación token no paga/reserva; política inmutable; API antigua conserva/revalida base al editar borrador, campo nuevo rechazado; copia cliente no transfiere cobros.
- [ ] Tests nuevos FAIL→implementar proyección segura y conservación→PASS más regresiones públicas/conversión/integración. No cambiar vencimiento contable de venta crédito.
- [ ] Commit/ledger.

### Task 7: UX compacta

**Files:** F shared/EventPaymentTermsFields, appointments/components/EngagementPaymentStatus; QuoteEditor; commercialTypes/Api; EngagementLines/Payments,AgendaActions,MoveDialog, detalles/resumen/creación contratación; tests agenda-payment-policy y quotes.event-payment-terms.
**Interfaces:** fields=`{value,total,currencyCode,disabled,onChange,errors}`, status=`{state,onCollect,onSchedule,onReview}`; payload excepción/revisión de tareas4–5.
- [ ] RED opt-in compacto sin datos inventados, vacíos no cero, estados claros, borrador preservado en error/versión/cambio de ámbito.
- [ ] Tests FAIL→reutilizar Button/Input/Label/Select/MetricStrip/FormFeedback/guardas/alertas→PASS. Inputs numéricos acotados, responsive sin huecos; CTA principal contextual. No «marcar pagado» sin cobro. Excepción puntual con motivo y ConfirmDialog, no switch permanente.
- [ ] Revisión antes/después fecha y vencimiento. Accesibilidad/foco/error/loading/doble envío. Typecheck/build/módulos PASS; navegador hidratado375/768/1440 claro/oscuro sin overflow, teclado.
- [ ] Commit/ledger.

### Task 8: Concurrencia y entrega

**Files:** `tests/appointments.payment-policy-concurrent.e2e.js`, docs/inventario/condiciones-pago-servicios-verificacion.md y paquetes-comerciales.md.
- [ ] PostgreSQL temporal dos conexiones: cobro vs inicio; devolución/liberación vs cierre; compromiso→aplicación; dos acuerdos mismo cliente; corrección venta; reprogramar vs cobro; hash/permiso revocado; clase compartida; rollback segundo horario; reintentos sin duplicados/deadlocks.
- [ ] B npm test/test:modules; F suite concurrency2, tsc/build/modules; migración/concurrencia opt-in, regresiones2A/2B.1 y visual PASS. Registrar evidencia real y límites.
- [ ] Revisión independiente final de este bloque con Review Focus; importantes/críticos una pasada RED→GREEN+suite. Preservar cambios ajenos, sin push/merge.
- [ ] Entregar implementado vs desplegado; pedir autorización específica para migración/generación/reinicio si corresponde. No tests operativos reales ni contacto externo.
