# Reconciliación de migraciones y pagos por empresa — verificación

Fecha: 15 de octubre de 2026, hora de Guatemala.

## Estado ejecutado

Aplicado en la **Supabase de desarrollo existente**, autorizada por el usuario. No se creó otra instancia ni una base local, no se copiaron clientes a una base de ensayo y no se ejecutó reset, db push ni la semilla general.

La cadena activa contiene `0_auna_baseline_20261015` y `202610150002_company_payment_methods`. Las 75 migraciones anteriores están completas en `prisma/migrations-archive/pre-baseline-20261015`, con manifiesto de checksums. La migración de pagos conserva sus bytes originales.

El historial remoto anterior fue trasladado, no editado ni reconstruido, a `auna_migration_audit._prisma_migrations_20261015`. Se verificaron identidad de tabla y huella de todas sus filas. El esquema administrativo tiene propietario verificado, marca de ejecución y permisos restringidos; no se concedió acceso a clientes.

Prisma registró oficialmente la baseline como aplicada; **su DDL no se ejecutó sobre tablas existentes**. Después se aplicó pagos mediante deploy, se generó Prisma Client 6.14.0 y el estado nativo informó dos migraciones y esquema actualizado, sin divergencias ni pendientes.

Se compararon las proyecciones originales de todas las tablas de negocio después del despliegue y de la limpieza financiera: coincidieron todas. Quedaron las 53 empresas originales, 318 preferencias inicializadas, cero métodos privados de los fixtures y los 100 registros históricos originales preservados. El segundo deploy no cambió la huella de preferencias; no quedaron esquemas QA. Los recibos privados conservan las huellas completas.

## Evidencia

| Comprobación | Resultado |
| --- | --- |
| Respaldo de public e historial, snapshot consistente, checksums y listado pg_restore | Verificado; archivos privados, fuera de Git |
| Archivo histórico local | 75 migraciones, bytes idénticos |
| Instalación vacía en la misma Supabase | Baseline y pagos mediante Prisma, no modelos incompletos ni db push |
| Fidelidad | Columnas generadas, CHECKs, índices especiales, funciones, triggers, políticas y dependencias inventariados |
| Recuperación real entre esquemas | Rollback de corte, reanudación, dos recuperaciones y nuevas promociones, intentos preservados sin colisión |
| Bloqueo administrativo | Otra conexión comprobó que permanece retenido y se libera al terminar |
| Limpieza del ensayo | Ambos esquemas UUID exactos eliminados y ausencia comprobada |
| Segundo deploy de ensayo | Sin migraciones ni cambios de historial |
| Backend local | 719/719 pruebas;97/97 de módulos; esquema Prisma válido |
| Frontend | 709/709 pruebas;23 fronteras de módulos; compilación Vite exitosa |
| Integración financiera en public | 7/7 casos reales, con opt-in explícito y limpieza por IDs conocidos |

La integración financiera comprobó aislamiento entre empresas, nombres privados normalizados, asociaciones ajenas rechazadas, locks de lectura/escritura, desactivaciones concurrentes, inicialización idempotente y resguardos de ventas confirmadas. Emitió una venta real de Agenda con dos recibos bancarios de50 sobre un servicio de100, verificó dos aplicaciones y los asientos correspondientes, y repitió el mismo intento sin generar dinero, aplicaciones ni asientos adicionales.

Las comprobaciones negativas hacen rollback incluso si una operación es aceptada inesperadamente. Sus mensajes PostgreSQL de rechazo aparecen como errores esperados en el log; la ejecución final pasó, sin pruebas omitidas.

## Revisión y correcciones verificadas

Una revisión independiente de solo lectura encontró tres problemas importantes. Se reprodujeron y corrigieron en una pasada:

1. Al recuperar el historial nuevo, su PK podía colisionar con la del historial original. Ahora se renombra exclusivamente el intento nuevo antes de trasladarlo.
2. Recuperar y promover otra vez rechazaba el esquema administrativo propio. Ahora se comprueban propietario, marca, ACL y contenido exacto antes de reutilizarlo; intentos sucesivos no se sobrescriben.
3. La ventana sin escritores ignoraba conexiones de otros usuarios. Ahora requiere visibilidad de estadísticas y comprueba sesiones de todos los roles, excluyendo únicamente conexiones propias identificadas y sesiones inactivas.

Las regresiones fallaron antes de corregirse y pasaron después; el ensayo PostgreSQL se repitió con dos namespaces independientes para ejercer el mismo movimiento entre esquemas que en public. No quedaron hallazgos menores diferidos ni se solicitó otra revisión para sustituir esas pruebas.

## Incidencias conservadas

- La falta de espacio local interrumpió una escritura de prueba. Se preservó el avance, el usuario liberó espacio y se restauró el archivo antes de continuar; no se escribió en Supabase durante ese incidente.
- La entrada real de la CLI descubrió una dependencia circular por inicializar exports después de main. Un subprocess de regresión reprodujo el fallo; se corrigió el orden, sin añadir operaciones de base.
- Un intento nativo devolvió `Schema engine error`. Antes de reintentar se comprobó BASELINED, ausencia de tabla/intento fallido de pagos y únicamente pagos pendiente. El reintento controlado pasó; no se repitió el traslado ni se ejecutó la baseline.
- El primer escenario financiero encontró campos del padre repetidos en una creación anidada del fixture. El código de negocio ya tenía el contrato correcto; se ajustó únicamente el fixture al cliente generado. La ejecución real posterior pasó7/7.
- Permanecen advertencias existentes de configuración Prisma deprecada, Browserslist y bundles grandes. No se actualizaron dependencias para ocultarlas.

## Decisiones y sus límites

| Decisión | Coste o límite |
| --- | --- |
| Conservar las carpetas elegidas por el usuario | Menor aislamiento; commits acotados |
| Usar encabezados Task para el ejecutor del plan | Cambio exclusivamente documental |
| Conservar siete FK adicionales como SQL explícito | Un diff desde modelos puede proponer eliminarlas; no ejecutarlo ciegamente |
| No reemplazar todos los modelos por la introspección | Sus relaciones 1:1 derivadas de índices parciales no compilan; SQL conserva esa unicidad |
| Separar la orquestación del ensayo de la CLI | Un módulo enfocado adicional |
| Normalizar solo slots físicos de enums y casts equivalentes comprobados | Esas representaciones equivalentes comparan iguales; valores, orden y reglas siguen comprobándose |
| Mantener los probes de recuperación en un helper de pruebas | La CLI de ensayo de desarrollo requiere esos archivos; el servidor no los carga |
| Exigir HEAD revisado y árbol limpio para promover | Cambios de código requieren nueva disposición de revisión/verificación |
| Preservar RLS sin rediseñarlo | No certifica la seguridad de las políticas preexistentes |
| No duplicar la revisión anterior del dominio de pagos | La integración real sigue siendo obligatoria; aquí pasó |
| No certificar semilla general, onboarding, Storage o FEL | Necesitan configuración y pruebas separadas |
| No inferir UI ni despliegue de una revisión de preparación | El despliegue se verificó aparte; la revisión visual continúa pendiente |
| Compilador acotado al SQL capturado y checksums revisados | Construcciones futuras desconocidas requieren tests y extensión explícita |
| Dos esquemas temporales exactos para source/audit | Un namespace transitorio adicional; ambos se eliminaron |

## Procesos, respaldo y pendientes

No había listeners Auna3000/8080 al comenzar ni al promover; no se detuvo, reinició ni inventó una segunda instancia. El respaldo y los recibos tienen además una copia persistente privada en el directorio local de respaldos Auna, con permisos0700/0600; no dependen exclusivamente de/tmp. Se verificó la integridad del archivo, no una restauración completa de clientes sobre otra base.

**Pendiente:** abrir la aplicación compatible y revisar métodos de pago en claro, oscuro, móvil y al cambiar de empresa. No se certificó `/health` ni una sesión visual con servidores cerrados. Esto mantiene abierta la parte visual de la tarea9 de pagos, no la migración aplicada.

Este resultado corresponde solamente a la Supabase de desarrollo autorizada. No reconcilia automáticamente otra base histórica ni certifica producción, certificadores FEL, políticas Storage o onboarding desde una instancia nueva.
