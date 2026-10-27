# Condiciones de pago de servicios — bloque 2C

## Alcance implementado

Una condición opcional para **todo el acuerdo**, no un anticipo por evento o paquete. Incluye el total neto de bienes y servicios. No reemplaza contado/crédito ni crea otro saldo contable.

- Porcentaje acordado (0–100, hasta dos decimales), días de calendario (0–365), primera prestación prevista y zona horaria. Sin porcentajes ni plazos predeterminados.
- Cotización: alta/edición de borrador, revisión de versión, congelación al enviar/aceptar y conservación al convertir a pedido, venta y contratación. La omisión en una edición antigua conserva la condición; un cambio de partidas recalcula su base en el servidor.
- Contratación directa: el comando existente acepta la condición al crearla. Las reservas/actividades independientes que ya existen siguen sin condiciones retrospectivas; no se agregó otra pantalla de creación ni un editor de condiciones en los cobros de un acuerdo existente.
- La aceptación pública no cobra ni reserva horarios. Las páginas públicas y los documentos oficiales reciben solo condiciones acordadas; nunca recibos, excepciones o asignaciones privadas.
- Confirmación calculada desde la programación vigente, las asignaciones y el anticipo efectivamente comprometido/aplicado. Un recibo aplicado a una venta no se cuenta dos veces; el crédito libre de otro acuerdo no lo cubre.
- Inicio/finalización/confirmación de realización revisan nuevamente las condiciones. El cierre automático de horario no confirma la realización comercial.
- Saldo vencido: una excepción puntual requiere `appointments.override_payment_policy` y acceso financiero, motivo, acción y contexto actual. No cambia la deuda. El permiso se crea sin asignarlo a roles automáticamente.
- Reprogramar el primer servicio muestra el vencimiento anterior y nuevo. Sin consentimiento no se guarda ninguna parte del cambio. Un cobro o cambio de versión invalida la revisión anterior. Cancelar no devuelve dinero ni prorroga silenciosamente el saldo.

## UX

Se reutilizan los controles, superficies, alertas y confirmaciones de Auna. La opción de anticipo empieza cerrada; los campos numéricos tienen ancho acotado. Los errores conservan el borrador y enfocan el primer campo inválido. El resumen propone programar, registrar un abono o revisar, según el estado; no existe «marcar pagado».

La opción se habilita solo si el servidor reconoce las columnas y el cliente generado. Hasta terminar el despliegue se muestra una explicación breve, sin permitir enviar condiciones a un almacenamiento antiguo.

## Evidencia aislada (27 de octubre de 2026)

| Comprobación | Resultado |
| --- | --- |
| Backend, suite completa | 1730/1730 |
| Backend, módulos | 97/97 |
| Frontend, suite completa con concurrencia 2 | 1472/1472; prueba adicional de excepción incluida en el grupo dirigido de abajo |
| UI dirigida: condiciones, borrador, revisión, acciones | 25/25 |
| TypeScript, build y fronteras de 23 módulos | Correctos; build conserva aviso de tamaño de chunks existente |
| Migración nueva, PostgreSQL temporal y clientes temporales | 1/1; huellas de todas las tablas anteriores conservadas, checks y rollback |
| Concurrencia financiera 2C, PostgreSQL, dos clientes | 9/9 |
| Regresión de requisitos 2A en PostgreSQL | 6/6 |
| Regresión de cronograma 2B.1 en PostgreSQL | 9/9 |
| Controles React hidratados, 375/768/1440, claro/oscuro | 6 combinaciones sin desbordamiento; teclado, foco de error y cancelar/aceptar revisión |

La aceptación financiera incluye espera real en el bloqueo del cliente durante cobro/liberación, conversión compromiso→aplicación, otro acuerdo del mismo cliente, corrección de venta, hash obsoleto, permiso retirado, transición operativa con excepción idempotente, cancelación sin devolución, cambio de fecha tras otro cobro, inscripciones de clientes distintos en una clase y rollback del segundo horario. No es una simulación de respuestas HTTP contra la base activa.

Repetición: `tests/event-payment-terms.migration.pg.e2e.js` exige una base **vacía** mediante `EVENT_PAYMENT_TERMS_TEST_DATABASE_URL`. `tests/appointments.payment-policy-concurrent.e2e.js` usa una base ya migrada. Ambos rechazan destinos que no sean loopback y no tengan nombre `auna_payment_terms_test_*`; no usan la conexión de la aplicación como alternativa. Los clientes generados viven en directorios temporales, no en el cliente activo.

La revisión visual usa `tests/visual/event-payment-preview.cjs` y `tests/visual/event-payment.verify.cjs`, con datos ficticios y sin sesión/API. No sustituye una prueba con sesión real después del despliegue. Capturas: `deposito-frontend/output/playwright/payment-*.png`.

## Despliegue pendiente

**No se aplicó `20261029120000_event_payment_terms` a la base activa, no se regeneró su cliente ni se reiniciaron servicios para activarlo.** Requiere autorización específica. Antes de desplegar: revisar las migraciones pendientes exactas, respaldo/política de recuperación, aplicar únicamente la secuencia autorizada y luego generar el cliente y reiniciar coordinadamente. No usar una generación nueva contra una base sin migrar.

Después de activar, verificar con datos de prueba autorizados las pantallas autenticadas de cotización, contratación y Agenda, y asignar deliberadamente el permiso de excepción si corresponde. No se contactó Infile, DonShot ni servidores externos; tampoco se envían notificaciones, cobros web ni datos mediante una API nueva.

## Decisiones de ejecución

El plan original sobrescrito se preservó y el alcance aprobado se recuperó en otro archivo. Se mantuvieron los checkouts con sus prerrequisitos sin confirmar y se guardaron baselines para revisar solo este bloque. Por ello algunos cambios sobre archivos previamente modificados siguen sin incorporarse a los commits de control; no deben desplegarse solo esos commits sin revisar los cambios conectados.

La evidencia y los baselines se conservan mientras existan esos cambios pendientes; no se elimina material necesario para distinguir el trabajo previo del bloque 2C.
