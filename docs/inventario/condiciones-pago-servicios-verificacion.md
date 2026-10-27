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
| Backend, suite completa | 1732/1732 |
| Backend, módulos | 97/97 |
| Frontend, suite completa con concurrencia 2 | 1476/1476 después de las correcciones de revisión |
| UI dirigida: condiciones, borrador, revisión, acciones | 25/25 |
| TypeScript, build y fronteras de 23 módulos | Correctos; build conserva aviso de tamaño de chunks existente |
| Migración nueva, PostgreSQL temporal y clientes temporales | 1/1; huellas de todas las tablas anteriores conservadas, checks y rollback |
| Concurrencia financiera 2C, PostgreSQL, dos clientes | 9/9 |
| Regresión de requisitos 2A en PostgreSQL | 6/6 |
| Regresión de cronograma 2B.1 en PostgreSQL | 9/9 |
| Controles React hidratados, 375/768/1440, claro/oscuro | 6 combinaciones sin desbordamiento; teclado, foco de error y cancelar/aceptar revisión |

La aceptación financiera incluye espera real en el bloqueo del cliente durante cobro/liberación, conversión compromiso→aplicación, otro acuerdo del mismo cliente, corrección de venta, hash obsoleto, permiso retirado, transición operativa con excepción idempotente, cancelación sin devolución, cambio de fecha tras otro cobro, inscripciones de clientes distintos en una clase y rollback del segundo horario. No es una simulación de respuestas HTTP contra la base activa.

La revisión independiente encontró dos omisiones importantes de presentación, ambas reproducidas y corregidas: los pedidos y su PDF podían ocultar condiciones válidas al calcular un vencimiento durante un cambio de horario estacional; y la vista de venta omitía condiciones que sí estaban guardadas. Los lectores guardados de pedido, venta y contratación ahora reciben el vencimiento calculado por el servidor. Una vista previa sin guardar conserva el porcentaje, los días y la referencia si no puede resolver la hora exacta. La venta muestra este acuerdo por separado del vencimiento contable. Pruebas de regresión: lectores backend 2/2 y documentos/normalización/vista frontend 5/5.

Repetición: `tests/event-payment-terms.migration.pg.e2e.js` exige una base **vacía** mediante `EVENT_PAYMENT_TERMS_TEST_DATABASE_URL`. `tests/appointments.payment-policy-concurrent.e2e.js` usa una base ya migrada. Ambos rechazan destinos que no sean loopback y no tengan nombre `auna_payment_terms_test_*`; no usan la conexión de la aplicación como alternativa. Los clientes generados viven en directorios temporales, no en el cliente activo.

La revisión visual usa `tests/visual/event-payment-preview.cjs` y `tests/visual/event-payment.verify.cjs`, con datos ficticios y sin sesión/API. No sustituye una prueba con sesión real después del despliegue. Capturas: `deposito-frontend/output/playwright/payment-*.png`.

## Despliegue aplicado el 27 de octubre de 2026

Con autorización explícita del usuario («autorizo»), se aplicó únicamente `20261029120000_event_payment_terms` a la base que usa localhost, alojada en Supabase. Era la única migración pendiente; no había migraciones fallidas ni diferencias de checksum en las migraciones activas. No se ejecutó el seed ni se cambiaron documentos, cobros o saldos para probar la función.

Se creó un respaldo privado del esquema público y sus datos, con permisos de directorio 0700/archivo 0600. Se comprobó su checksum y el índice de restauración de `pg_restore`; no se hizo una restauración completa del respaldo activo. Comprobante local persistente: `/home/DiegoPatzan/.local/state/auna/backups/2026-10-27-payment-terms-5JwTaK/manifest.json`. La copia inicial temporal también se conserva.

Antes de iniciar el backend se compararon las huellas de 163 tablas: ninguna fila previa cambió (se excluyeron únicamente los metadatos de migración y el permiso nuevo). Las cuatro columnas nuevas son JSONB opcionales, todos los acuerdos previos continúan sin política y el nuevo permiso no quedó asignado a ningún rol. Evidencia privada: `/home/DiegoPatzan/.local/state/auna/backups/2026-10-27-payment-terms-5JwTaK/verification.json`.

Se regeneró el cliente activo Prisma 6.14.0 y se inició el backend en el puerto 3000. La comprobación de disponibilidad devuelve `true`, las lecturas con el cliente nuevo funcionan para documentos, ventas y contrataciones, y `/health` devuelve `ok:true`. La ruta de capacidad sin autenticación devuelve 401. Las pruebas dirigidas después de generar el cliente pasaron 17/17. El frontend, también detenido, se inició en el puerto 8080; responde y su proxy conserva la autenticación del backend.

Para otros entornos: revisar destino y migraciones pendientes, obtener respaldo/política de recuperación, aplicar únicamente la secuencia autorizada y después generar el cliente e iniciar/reiniciar coordinadamente. No generar un cliente nuevo contra una base sin migrar.

El control de disponibilidad no hace compatibles todas las consultas si se instala un cliente generado nuevo contra una base sin migrar: esa combinación no está soportada. La actualización debe respetar el orden anterior. No se agregaron permisos de API ni una pantalla nueva para contratar directamente; esa alta sigue disponible mediante el comando existente, mientras que la opción de interfaz se configura en cotizaciones con servicios.

Queda la comprobación funcional autenticada con datos de prueba autorizados de cotización, contratación y Agenda. El permiso de excepción debe asignarse deliberadamente si corresponde. No se contactó Infile, DonShot ni servidores anteriores; solo se usó la base configurada y los procesos locales. No se ejecutaron cobros, confirmaciones ni excepciones de prueba en la base activa.

## Decisiones de ejecución

El plan original sobrescrito se preservó y el alcance aprobado se recuperó en otro archivo. Se mantuvieron los checkouts con sus prerrequisitos sin confirmar y se guardaron baselines para revisar solo este bloque. Por ello algunos cambios sobre archivos previamente modificados siguen sin incorporarse a los commits de control; no deben desplegarse solo esos commits sin revisar los cambios conectados.

La evidencia y los baselines se conservan mientras existan esos cambios pendientes; no se elimina material necesario para distinguir el trabajo previo del bloque 2C.
