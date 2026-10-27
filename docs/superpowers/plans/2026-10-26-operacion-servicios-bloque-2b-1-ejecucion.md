# Operación de servicios 2B.1 — ejecución recuperada

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task, inline. Steps use checkbox syntax.

**Goal:** Cronograma y presencia real de personal/equipo sin duplicar reservas ni debilitar requisitos 2A.
**Architecture:** Actividades actuales, JSON versionado, proyección temporal compartida y transacciones existentes; sin nuevas sesiones por hito.
**Tech Stack:** CommonJS/Prisma/PostgreSQL y React/TypeScript; componentes Auna, sin dependencias nuevas.
**Spec:** `../specs/2026-10-26-paquetes-productos-servicios-design.md`.

Recupera el plan completo presentado en el chat y aprobado con «nice ahora si el plan 2b esta aprobado». El original `2026-10-26-operacion-servicios-bloque-2b-1.md` mide 0 bytes al iniciar y se conserva intacto. No es una ampliación de alcance. UI solicitada expresamente: amigable, clara, compacta, sin huecos grandes, controles y patrones existentes.

## Global Constraints

- Solo Auna: sin Infile, DonShot, SSH, conexiones externas, pagos, stock o datos reales de demostración.
- 2B.1 = horarios/hitos. 2B.2 posterior = zonas y cargos de traslado. 2C = anticipos y confirmación. No anunciar estos últimos como hechos.
- Aceptar cotización no programa ni cobra. Cantidades/sabores se acuerdan al cotizar.
- Preservar acuerdos, política congelada, cupos, identidades, permisos y requisitos 2A. Revalidar en la transacción y recibos existentes.
- Migración aditiva primero en PostgreSQL desechable; autorización aparte antes de aplicar a localhost o regenerar su cliente activo.
- Preservar cambios mixtos; no modificar migraciones aplicadas ni resetear archivos. Sin CRUD público nuevo ni publicación de identidades/horarios privados.

## Review Focus

1. Alias usuario/profesional/empleado comparten la unión temporal, sin doble reserva.
2. Una ventana corta nunca satisface FULL ni dos plazas simultáneas con una sola identidad.
3. La envolvente SQL no bloquea a todo participante; lecturas de citas/clases, alertas y vinculación usan la proyección precisa.
4. Mover/acortar o editar con cliente antiguo no borra cronograma ni recorta horarios silenciosamente.
5. Hitos no duplican ocupación; escrituras simultáneas de distintas actividades sí compiten por identidad.

## Contratos y decisiones ya presentadas

B = deposito-backend; F = deposito-frontend. Cambios inicialmente en ACTIVITY, libre o servicio WORK, incluida contratación. Citas/clases mantienen formularios y reglas; sus consultas respetan ocupación precisa ajena.

`AppointmentSession.operational_timeline` JSONB default `{schemaVersion:1,milestones:[],attendanceWindows:[],requirementWindows:[]}`. Tamaño máximo 64 KiB UTF-8; claves cerradas, IDs UUID únicos, offsets enteros no negativos y fin posterior al inicio dentro de duración real.

- `Milestone={id,name,startOffsetMinutes,endOffsetMinutes}`: máximo32, nombre150. Puede coincidir con otros hitos: no ocupa por sí mismo.
- `AttendanceWindow={kind:'USER'|'PROVIDER'|'RESOURCE',entityId,startOffsetMinutes,endOffsetMinutes,outboundMinutes,setupMinutes,teardownMinutes,returnMinutes}`: máximo100, clave kind/ID única, referencias ya asignadas. Márgenes enteros0–1440. Omitir ventana=todo el intervalo operativo; organizador siempre completo; invitados no reservan.
- `RequirementWindow={requirementId,milestoneId}`: máximo20, único por requisito INTERVENTION, obligatorio para cada uno. Toda su cantidad debe cubrir simultáneamente el hito entero.
- Offsets desde inicio UTC, no horas de pared. Cambiar zona conserva instante. Mover conserva offsets y valida nuevamente; acortar fuera de límites falla, no recorta.
- Ventana propia ocupa llegada menos ida/montaje y salida más cierre/regreso. UI pide revisar márgenes, no asigna cero silenciosamente ni crea cargo monetario.
- `occupied_from/until` es envolvente de todos los bloques. Asignaciones FULL usan intervalo base, no envolvente de otro participante. Unir por identidad canónica.
- Requisito extiende `attendanceMode:'FULL'|'INTERVENTION'`; ausente anterior=FULL. INTERVENTION solo WORK. Cliente viejo que omite modo conserva por ID; omitir timeline al editar conserva el guardado. Política congelada y hash incorporan modo; resumen público solo modo/nombre/tipo/cantidad, sin IDs.
- Booleanos antiguos sin requisitos conservan obligación de al menos una asignación completa; extras pueden tener horario propio. Emparejamiento existente ampliado con elegibilidad por requisito, sin selección voraz ni identidad repetida.

## Task 1: Dominio temporal y requisitos

**Files:** crear `src/modules/appointments/domain/operationalTimeline.js`, `tests/appointments.operational-timeline.test.js`; modificar `domain/assignmentRequirements.js`, `domain/servicePolicy.js`, tests requisitos.
**Interfaces:** `parseOperationalTimeline(raw)`; `resolveOperationalTimeline({timeline,session,identityById})->{occupiedFrom,occupiedUntil,blocks,milestones}`; `requirementEligibility({requirements,timeline,session,identityById})->Map<requirementId,Set<entityId>>`. Session normalizada: startsAt/endsAt/organizerId/userIds/providerIds/resourceIds/cuatro márgenes. Bloque={start:epochMs,end:epochMs,userIds,providerIds,resourceIds}; hitos resueltos añaden startsAt/endsAt ISO. Resolver requisitos acepta `eligibleByRequirement?`.
- [ ] RED: fixture18:00–22:00, márgenes30/15/15/30→equipo17:15–22:45; profesional offsets60–90, ida/regreso10/10→18:50–19:40. Hito no crea bloque; alias responsable ocupa todo. A FULL p1/p2, B INTERVENTION p1→A:p2 B:p1. Dos personas19:00–19:15/19:15–19:30 no cubren cantidad2 hito19:00–19:30. Límites33/101/21, tamaño, NaN, huérfanos, duplicados, márgenes1441, DST/medianoche/adyacencia.
- [ ] Verificar RED: `node --test tests/appointments.operational-timeline.test.js tests/appointments.requirements.test.js`.
- [ ] Implementar proyección determinista semiabierta/unión por identidad y elegibilidad mediante emparejamiento existente. Legado equivalente.
- [ ] GREEN mismo comando. Checkpoint propio.

## Task 2: Persistencia y política congelada

**Files:** schema, profiles.js, configuredActivities.js, domain/publicServiceConditions.js, commercialQueries.js; nueva migración `20261028120000_activity_operational_timeline/migration.sql`; tests `appointments.timeline-profile.test.js`, `appointments.timeline-migration.pg.e2e.js`.
**Interfaces:** modos de requisitos, ActivityInput.operationalTimeline opcional y DTO normalizado; revisión/conditionsVersion actuales.
- [ ] RED: FULL anterior, INTERVENTION soloWORK, omisión conserva, versión vieja falla; cambio de modo invalida hash nuevo pero no acuerdo/sesión anterior; proyecciones públicas acotadas.
- [ ] Verificar RED: `node --test tests/appointments.timeline-profile.test.js tests/appointments.requirements-commercial.test.js`.
- [ ] Implementar columna default/CHECK objeto-versión-arrays-límites-tamaño y guardas completas servidor; no reescribir JSON anterior para agregar FULL.
- [ ] GREEN + PostgreSQL opt-in `APPOINTMENTS_TIMELINE_TEST_DATABASE_URL`, loopback/base `auna_timeline_test_*`, sin fallback a app; comparar huellas salvo columna nueva, rollback y cliente temporal. No aplicar activo.

## Task 3: Ocupación precisa en todas las lecturas

**Files:** occupancy.js, domain/availability.js, queries.js, entries.js, directory.js; tests `appointments.timeline-occupancy.test.js`, availability/occupancy existentes.
**Interfaces:** loadBusyAssignments produce varios bloques por sesión con sessionId/session; consumidores deduplican sesiones/cupos. SQL preselecciona envolvente; Task1 decide conflicto real.
- [ ] RED: persona19:00–19:30 libre20:00, equipoFULL no; conflicto19:15 en citas/clases/actividades/listado; alias bloquea; varios bloques no duplican clase; directory no compara envolventes ajenas.
- [ ] Verificar RED: `node --test tests/appointments.timeline-occupancy.test.js tests/appointments.availability.test.js tests/appointments.occupancy.test.js`.
- [ ] Implementar selects completos/proyección/fallback, calendarios/ausencias por identidad e intervalo, exclusión propia y límites actuales.
- [ ] GREEN más entries/directory/conflictos; cancelar solo libera lo suyo, completed conserva márgenes; buscar todos los consumidores occupied_from/until y loadBusyAssignments.

## Task 4: Crear/programar/editar transaccionalmente

**Files:** domain/activities.js, activities.js, configuredActivities.js, engagementScheduling.js; `appointments.timeline-scheduling.test.js`, regresiones actividades/contrataciones.
**Interfaces:** timeline opcional actividad y programs[] WORK; rechazar no vacío para citas/clases. Guardar timeline/envolvente/asignaciones/versiones juntos.
- [ ] RED: guardar/leer, contratación mismas reglas, requisito incompleto/segundo programa revierte todo; revisión vieja falla; omisión conserva, vacío explícito revalida; mover conserva offsets, acortar falla.
- [ ] Verificar RED: `node --test tests/appointments.timeline-scheduling.test.js tests/appointments.requirements-scheduling.test.js tests/appointments.engagements.test.js`.
- [ ] Implementar Task1 dentro de bloqueo; sin hijos por hito; historial mínimo sin notas/direcciones; no modificar cantidades/importes.
- [ ] GREEN + actividades/reintentos/key distinta/legado; no nuevos recibos ni aumentos de timeout.

## Task 5: UI amigable/compacta y borradores

**Files:** F appointments/types.ts, commercialTypes.ts, activityDraft.ts, engagementDraft.ts, components/ActivityFields.tsx, AssignmentRequirementsFields.tsx, pages/ActivityDetailPage.tsx, EngagementSchedulePage.tsx; nuevos OperationalTimelineFields.tsx, tests/agenda-operational-timeline.test.cjs, tests/visual/operational-timeline-preview.cjs.
**Interfaces:** OperationalTimelineFields({value,onChange,session,assignments,disabled,errors}); borradores incompletos locales, programación inválida no se guarda.
- [ ] RED: agregar momento enfoca nombre/conserva anteriores; FULL default, horario propio expone márgenes; requisitoFULL explica restricción; mover/error/contexto no pierde ni mezcla borradores; solo lectura no edita.
- [ ] Verificar RED: `node --test tests/agenda-operational-timeline.test.cjs`.
- [ ] Implementar páginas existentes, controles Auna, secciones progresivas «Momentos del evento», «Horarios del personal y equipo», «¿En qué momento se necesita?» y «Se reserva de…a…». Sin modales grandes, duplicados ni huecos; fechas legibles/teclado/foco/errores cercanos/DraftGuard. Citas/clases sin nuevos formularios.
- [ ] GREEN regresiones Agenda + visual375/768/1440 claro/oscuro hidratada/sintética, sin registros reales.

## Task 6: Aceptación y entrega

**Files:** tests/appointments.timeline-concurrent.e2e.js, docs/inventario/cronograma-servicios-verificacion.md, paquetes-comerciales.md.
**Interfaces:** base temporal Task2 y rutas/recibos existentes.
- [ ] RED: dos conexiones mismo profesional19:00–19:30→solo una; horarios19:00–19:30/20:00–20:30→ambas aunque eventos se solapen; equipoFULL impide segunda; fallo/reintento/alias/ausencia reales PostgreSQL.
- [ ] Verificar RED en base desechable ya migrada.
- [ ] Completar integración mínima sin alterar bloqueos/atomicidad.
- [ ] GREEN backend npm test/módulos; frontend suite completa concurrencia4, tsc app, build/módulos; migración/concurrencia/2A/visual y revisión independiente final.
- [ ] Documentar límites/resultados; pedir despliegue si pendiente. No afirmar 2B.2/2C/API/web; siguiente plan2B.2.
