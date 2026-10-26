# Requisitos de personal y equipo — Bloque 2a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exigir y explicar qué profesionales y equipos necesita cada servicio antes de programarlo, reutilizando Agenda y conservando lo ofrecido en la cotización.

**Architecture:** Extender el perfil versionado con requisitos acotados, no otro catálogo. Una función pura encuentra asignaciones distintas y se reutiliza al consultar y al reservar dentro de la transacción existente. Las sesiones conservan su política; las cotizaciones conservan un resumen público sin opciones privadas.

**Tech Stack:** Node.js/CommonJS, Prisma/PostgreSQL, React/TypeScript y controles existentes. Sin dependencias nuevas.

**Spec:** `/home/DiegoPatzan/Documents/CODE/Auna/deposito-backend/docs/superpowers/specs/2026-10-26-paquetes-productos-servicios-design.md`.

Recuperación del plan presentado y aprobado en el chat: el archivo original
`2026-10-26-requisitos-servicios-bloque-2a.md` ahora contiene «si esta bie» y se
conserva intacto. Esta copia recupera su alcance, contratos y seis tareas; no es
un diseño nuevo. Aprobación: «si esta bien», después del enlace al plan original.

## Global Constraints

- Las cantidades y sabores se acuerdan en la cotización.
- Personal y equipo no son consumibles ni stock del paquete.
- Aceptar cotización no reserva recursos ni recibe pagos.
- No modificar acuerdos o sesiones antiguas al cambiar el catálogo.
- Una misma identidad física/persona no satisface dos requisitos; no se añaden excepciones de compatibilidad en 2a.
- Disponibilidad se revalida dentro de la transacción; la consulta no reserva.
- No publicar opciones privadas, identidades de personal, costos o salarios.
- Solo Auna; sin DonShot, Infile, SSH ni proveedores externos.
- Migración aditiva primero en PostgreSQL temporal; pedir aplicación a localhost después, no crear registros reales.
- Preservar el trabajo mixto previo. Reutilizar calendarios, bloqueos, recibos, stock y cobros existentes.

## Review Focus

1. Opciones superpuestas: emparejamiento completo e identidad canónica, no asignación voraz ni conteo doble (Task 1).
2. Cobertura por cada sucursal/lugar y salas no transportables (Task 2).
3. Cumplimiento en citas, clases, trabajos configurados, inscripción y reprogramación, no solo contratación (Task 3).
4. Configuración nueva no cambia lo ofrecido ni endurece sesiones antiguas silenciosamente (Task 4).
5. Cambio de contexto, opciones archivadas y escrituras concurrentes no guardan asignaciones inválidas (Task 5–6).

## Alcance comprobado y decisiones técnicas

**B** = `/home/DiegoPatzan/Documents/CODE/Auna/deposito-backend`; **F** = `/home/DiegoPatzan/Documents/CODE/Auna/deposito-frontend`.

Agenda ya tiene perfiles compartidos, opciones habilitadas `providerIds`/`resourceIds`, booleanos `requiresProvider`/`requiresResource`, calendarios/ausencias, identidades usuario/empleado/profesional, equipo portátil y bloqueo transaccional por empresa. `computeSlots` elige un candidato requerido de cada tipo; `applyConfiguredActivityPolicy` comprueba presencia/pertenencia. Se extienden esos puntos.

`AssignmentRequirement = {id:UUID,kind:'PROVIDER'|'RESOURCE',name:string,quantity:integer,optionIds:UUID[]}`. Límites: 20 requisitos, nombres 100 caracteres, cantidad 1–20, hasta 100 opciones distintas por requisito, máximo 40 plazas entre todos, JSON 64 KiB. IDs estables/únicos. Lista vacía = flujo anterior. Unidad significa un registro físico/persona, no `person_capacity` ni stock.

Opciones pertenecen a las asignaciones habilitadas del perfil/empresa. Cada sucursal y lugar ofrecido debe poder satisfacer todos los requisitos con opciones compatibles. Profesionales se cuentan por identidad canónica de usuario/empleado. Sin requisitos de un tipo, su booleano mantiene la semántica anterior; con requisitos son obligatorios aunque el booleano antiguo sea falso. No multiplicar por horas/cantidad comercial: requisitos corresponden a cada programación.

Única columna nueva: `ServiceScheduleProfile.assignment_requirements` JSON default `[]`; cambia junto a la versión existente. `policy_snapshot` conserva requisitos completos privados al programar. `service_schedule_snapshot.assignmentRequirements` conserva solo nombres/tipos/cantidades ofrecidos, sin opciones ni identidades. El hash de revisión incluye las reglas privadas/versiones actuales; nunca se promete una persona concreta por ser una opción interna.

Consulta sin selección puede proponer un conjunto completo. Con selección explícita, todos sus IDs deben ser elegibles/libres y cubrir los requisitos: no se sustituyen silenciosamente; extras también quedan reservados. Emparejamiento determinista polinómico por caminos aumentantes. Inscribir en una clase valida las asignaciones reales/política congelada sin añadir equipo a la sesión.

Fuera: hitos, intervalos individuales nuevos, zonas/precio de traslado, anticipos/vencimientos, API externa. Se mantienen intervalos actuales completos, incluidos traslado/preparación. Esos puntos quedan para 2b/2c.

## Task 1: Contrato y asignación de requisitos

**Files:** crear `B/src/modules/appointments/domain/assignmentRequirements.js`, `B/tests/appointments.requirements.test.js`.

**Interfaces:** `parseAssignmentRequirements(raw) -> AssignmentRequirement[]`; `resolveAssignmentRequirements({requirements,candidates,selectedIds,identityById}) -> {assignments:[{requirementId,entityIds}],selectedIds}|null`; `publicAssignmentRequirements(requirements) -> [{name,kind,quantity}]`. Candidatos previamente filtrados por tipo/sucursal/lugar/disponibilidad.

- [ ] **Step 1 — RED.** A permite p1/p2, B solo p1: resolver A→p2/B→p1. Dos alias de una persona no cubren cantidad 2. Seleccionar solo p1 no se sustituye por p2. Rechazar cantidad 0/21, 21 requisitos, 41 plazas, IDs duplicados/malformados, tipo desconocido, opciones vacías y JSON >64 KiB. Orden distinto produce mismo resultado.
- [ ] **Step 2 — Verificar RED.** `node --test tests/appointments.requirements.test.js` falla por interfaces ausentes.
- [ ] **Step 3 — Implementar.** Cada cantidad se expande en plazas, emparejadas por identidad canónica mediante caminos aumentantes y orden estable por ID. No combinaciones ni dependencias.
- [ ] **Step 4 — GREEN.** Mismo comando PASS; ensayo 40 plazas ×100 opciones sin explosión combinatoria ni aserción frágil de milisegundos.
- [ ] **Step 5 — Checkpoint.** Revisar/confirmar solo archivos propios.

## Task 2: Guardado versionado y migración compatible

**Files:** modificar `B/prisma/schema.prisma`, `B/src/modules/appointments/profiles.js`, `domain/validation.js`, `domain/servicePolicy.js`; crear `B/prisma/migrations/20261027120000_service_assignment_requirements/migration.sql`, `B/tests/appointments.requirements-profile.test.js`, `appointments.requirements-migration.pg.e2e.js`.

**Interfaces:** `ProfileInput.assignmentRequirements?`; `presentProfile` siempre devuelve lista. `saveServiceProfile` valida opciones/cobertura, permisos y revisión. Campo omitido en cliente viejo conserva lista; `[]` explícito la quita con revisión válida.

- [ ] **Step 1 — RED.** Guardar/leer cantidad 2; referencias ajenas no resuelven; falta de cobertura en otra sucursal o sala para evento externo falla sin escrituras. Cliente viejo no borra, revisión vieja no sobrescribe, alias no cuentan doble.
- [ ] **Step 2 — Verificar RED.** `node --test tests/appointments.profile.test.js tests/appointments.requirements-profile.test.js`.
- [ ] **Step 3 — Implementar.** JSON default `[]`, CHECK array/tamaño. Reutilizar Task 1 y versión actual, no modificar migraciones aplicadas ni reservas/sesiones.
- [ ] **Step 4 — GREEN/migración.** Opt-in solo `APPOINTMENTS_REQUIREMENTS_TEST_DATABASE_URL`, loopback y nombre `auna_requirements_test_...`, rechazando URLs de app. Aplicar sobre fixtures previos, comparar perfiles/sesiones/políticas/asignaciones/recibos salvo nueva columna y probar rollback, sin fallback externo.
- [ ] **Step 5 — Checkpoint.** No aplicar a localhost ni regenerar su cliente antes de autorización. Separar hunk propio del esquema mixto.

## Task 3: Cumplimiento en todos los caminos de Agenda

**Files:** modificar `B/src/modules/appointments/domain/availability.js`, `queries.js`, `configuredActivities.js`, `application.js`, `occupancy.js` solo para identidad; probar `appointments.availability.test.js`, `appointments.service-policy.test.js`, nuevo `appointments.requirements-scheduling.test.js`.

**Interfaces:** `computeSlots` conserva DTO de IDs que cumplen requisitos; `policy_snapshot` conserva `assignmentRequirements`. `applyConfiguredActivityPolicy` usa mismo emparejamiento para selección explícita. Sin requisitos, flujo anterior.

- [ ] **Step 1 — RED.** Dos equipos solo ofrecen intervalos con ambos libres; crear cita/trabajo con uno falla `REQUIREMENTS_INCOMPLETE` sin sesión. Ausencias/alias no cuentan doble. Traslado/preparación reservan intervalo actual. Inscripción no altera asignaciones y reprogramación usa política original aunque cambie perfil.
- [ ] **Step 2 — Verificar RED.** Ejecutar los tres archivos de tests de la tarea y comprobar nuevas fallas.
- [ ] **Step 3 — Implementar.** Filtrar con utilidades existentes, Task 1 dentro de `withAgendaTransaction` al crear/reprogramar. Conservar cupos, capacidad, límites de consulta y exclusión propia.
- [ ] **Step 4 — GREEN.** Mismos tests más regresiones de actividades/citas/clases; alternativa válida si candidato ocupado y error recuperable si no hay conjunto completo.
- [ ] **Step 5 — Checkpoint.** No motor nuevo ni bloqueo alternativo.

## Task 4: Condiciones ofrecidas y revisión de contratación

**Files:** modificar `B/src/modules/appointments/index.js`, `domain/publicServiceConditions.js`, `commercialQueries.js`, `engagementScheduling.js`, `engagements.js`, `B/src/modules/quotes/controller.js`, `B/src/services/commercialPackages.js`; probar `appointments.requirements-commercial.test.js`, `packages.public.test.js`.

**Interfaces:** `publicConditionsFromRow`/`publicServiceConditions` conservan DTO más resumen opcional. `conditionInfo` incluye versión/reglas en hash; programar exige `acknowledgedConditionsVersion` vigente.

- [ ] **Step 1 — RED.** Cotizar dos profesionales/un equipo; cambiar perfil no modifica snapshot/importes. Contratación rechaza hash viejo. Cambiar opciones privadas invalida revisión aunque resumen no cambie. Público/PDF/API no contienen opciones/identidades/costos. Documento viejo sin resumen sigue funcionando.
- [ ] **Step 2 — Verificar RED.** `node --test tests/appointments.requirements-commercial.test.js tests/packages.public.test.js tests/packages.transitions.test.js`.
- [ ] **Step 3 — Implementar.** Capturar resumen servidor en servicio suelto/paquete y conservar conversiones. Política privada completa solo en programación, nunca proyección pública. Revisar selects de todos los productores reales de snapshot.
- [ ] **Step 4 — GREEN.** Más conversiones pedido/venta/Agenda; confirmar condiciones solo permite continuar tras comprobar asignaciones y disponibilidad.
- [ ] **Step 5 — Checkpoint.** Revisar allowlists de cada frontera pública.

## Task 5: Formularios compactos y mensajes de cumplimiento

**Files:** modificar `F/src/modules/appointments/types.ts`, `components/ServiceScheduleFields.tsx`, `pages/EngagementSchedulePage.tsx`, `components/ActivityFields.tsx`, `components/BookingFields.tsx`, `F/src/services/serviceConditions.ts`; crear `components/AssignmentRequirementsFields.tsx`, `F/tests/agenda-requirements.test.cjs`.

**Interfaces:** reutilizar `AssignmentChoices`/controles Auna. Mostrar requisito y cobertura «Equipo de atención · 1 de 2». Configurar opciones habilitadas; al programar elegir IDs concretos. Snapshot público solo resumen Task 4.

- [ ] **Step 1 — RED.** Sin permiso configurar no edita; lista vacía no añade obligación. Un equipo no completa dos. Opción archivada/contexto nuevo descarta respuesta tardía sin perder borrador. Público omite IDs; error indica qué falta.
- [ ] **Step 2 — Verificar RED.** `node --test tests/agenda-requirements.test.cjs`.
- [ ] **Step 3 — Implementar.** En página actual, no modal; sección progresiva «Requisitos específicos» en configuración. Pendientes visibles al programar, no ocultos. Formulario acotado/responsive/teclado. Enviar arrays actuales y validar conjunto sin sustitución silenciosa.
- [ ] **Step 4 — GREEN/visual.** Regresiones Agenda, 375/768/1440 claro/oscuro sin desborde de página, sidebar/foco/etiquetas/errores. Fixtures locales, no datos reales.
- [ ] **Step 5 — Checkpoint.** Sin dependencia/editor/tema alternativo.

## Task 6: Concurrencia, aceptación y entrega de 2a

**Files:** crear `B/tests/appointments.requirements-concurrent.e2e.js`; actualizar `B/docs/inventario/paquetes-comerciales.md` y evidencia 2a.

**Interfaces:** base temporal Task 2; reutilizar `command`/recibos existentes, sin tabla de idempotencia nueva.

- [ ] **Step 1 — RED.** Dos contrataciones compiten por equipo: solo una guarda. Reintento no duplica; conflicto no deja programación parcial si `partial=false`; fallo en segundo requisito revierte todo.
- [ ] **Step 2 — Verificar RED.** PostgreSQL sintético, sin endpoints externos/datos de clientes.
- [ ] **Step 3 — Completar integración mínima.** Conservar orden de bloqueo y validar en transacción, no resolver aumentando timeouts.
- [ ] **Step 4 — GREEN final.** Backend completo/módulos, frontend `node --test tests/*.test.*`, tsc/build, migración/aceptación/concurrencia y visual. Comparar legado. Una revisión independiente del código conectado/cambios mixtos al final.
- [ ] **Step 5 — Entrega.** Registrar límites/rutas; pedir aplicación de migración si falta. No anunciar hitos, traslado monetario, anticipos o web. Continúa 2b intervalos/hitos/traslado; 2c condiciones globales de pago/confirmación.

## Autorrevisión

Task 1–3: requisitos/alternativas/identidades y cobertura. Task 2–3: permisos/sucursal/legado. Task 4: condiciones ofrecidas, cambios y privacidad. Task 5: UX compacta. Task 6: atomicidad, recibos y concurrencia. 2a no es todo el bloque 2; siguientes tramos siguen pendientes.
