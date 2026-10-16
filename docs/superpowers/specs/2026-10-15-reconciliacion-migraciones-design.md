# Reconciliación de migraciones de Auna sin pérdida de datos

Fecha: 15 de octubre de 2026.
Estado: diseño aprobado para planificar mediante «continua»; ejecución pendiente de revisión del plan.

## 1. Objetivo y autorización

Desbloquear el despliegue de métodos de pago por empresa y dejar una cadena de migraciones que pueda instalar el esquema de Auna desde cero, sin borrar los datos de la Supabase de desarrollo actual.

El usuario aprobó el enfoque de una nueva línea de base, el archivo auditable del historial anterior y un esquema temporal vacío **en la misma Supabase** para ensayar la instalación. No aprobó crear otra instancia, clonar datos de negocio, resetear la base ni ejecutar la semilla general sobre los datos existentes. Se conserva la ejecución directa en las mismas carpetas.

Este documento concreta ese enfoque y fue presentado al usuario antes del plan de implementación. Su aprobación permite escribir el plan, no cambia por sí sola la prohibición vigente de desplegar con el historial divergente.

## 2. Diagnóstico comprobado

En las consultas de solo lectura del 15 de octubre:

- El repositorio contiene 76 migraciones; la base registra 100 intentos históricos. Existen nombres antiguos sin archivos en la cadena actual, incluidos intentos posteriormente revertidos.
- Los archivos locales correspondientes a migraciones finalizadas conservan sus checksums: no se detectó una modificación de su contenido.
- La última migración común es `202610150001_company_roles`. La única migración local pendiente es `202610150002_company_payment_methods`.
- El esquema `public` contiene 113 tablas, 47 restricciones CHECK, 14 índices parciales o de expresiones, 2 funciones propias y 4 triggers propios. El recuento de 5 obtenido inicialmente en `information_schema.triggers` corresponde a eventos, no a cinco triggers distintos.
- Las funciones propias son `capture_commercial_item_snapshot()` y `guard_confirmed_sale_payment_method()`. Hay dos políticas RLS en `sales`; su conservación no implica certificar que su política de acceso actual sea adecuada.
- La comparación del esquema real con `schema.prisma` propone cambios adicionales a pagos: entre ellos eliminar `product_lots.is_system_generated`, cambiar relaciones y tratar `roles.name_key`, que es una columna generada. Esa salida no es un script autorizado de corrección.
- No había listeners de Auna en los puertos 3000/8080 en la comprobación previa. La implementación debe volver a comprobarlo, no asumir que siguen detenidos.

Los recuentos son evidencia de ese momento, no valores que se puedan asumir inmutables al ejecutar.

## 3. Decisión de arquitectura

### Cadena ejecutable nueva

Crear una línea de base anterior a pagos que represente **el esquema real comprobado hasta `company_roles`**, no el esquema deseado que ya contiene pagos aún no aplicados.

La cadena activa tendrá:

1. `0_auna_baseline_20261015/migration.sql`: estado anterior a los nuevos métodos de pago, incluidos los objetos PostgreSQL que Prisma no expresa completamente.
2. `202610150002_company_payment_methods/migration.sql`: la migración pendiente, conservada con su contenido y checksum actuales.
3. Las migraciones futuras, añadidas después de esta entrega.

Las 75 migraciones locales anteriores se archivarán completas, con sus nombres y checksums, en `prisma/migrations-archive/pre-baseline-20261015/`, fuera del directorio ejecutable. Se conservará un manifiesto de procedencia. No se crearán archivos vacíos ni se restaurará la cadena preconsolidación dentro de la carpeta activa.

Un verificador y la documentación distinguirán archivos activos y archivados. Los scripts antiguos que escriben migraciones archivadas deben negarse a ejecutarlas contra `public` y orientar al procedimiento nuevo; no deben poder reintroducir la cadena antigua. Las pruebas que necesitan SQL histórico podrán leer el archivo preservado. Las pruebas de instalación actual deben usar la nueva cadena, no reconstruirla desde modelos omitiendo SQL propio.

### Historial remoto auditable

Para que el estado nativo de Prisma deje de comparar la nueva cadena con registros obsoletos, conservar la tabla histórica completa en un esquema administrativo persistente `auna_migration_audit`, con el nombre `_prisma_migrations_20261015`.

La promoción moverá la tabla original; no borrará, alterará ni fabricará sus filas, checksums, estados o fechas. El nuevo historial de `public` será creado y registrado por Prisma mediante el procedimiento de baseline, no mediante inserciones manuales. Esta es una operación excepcional y coordinada de metadata, no un parche para ocultar advertencias.

El esquema administrativo no se expondrá como API y sus permisos excluirán `PUBLIC`, `anon` y `authenticated`; el propietario/migrador conservará acceso. Se comprobarán colisiones y permisos antes de mover nada. No se sobrescribirá un archivo administrativo existente ni se reutilizará uno de otra ejecución.

Después de verificar que la base coincide con la línea de base, se registrará esta como ya aplicada. **No se ejecutará el SQL de creación de la baseline contra tablas de negocio existentes.** Solo entonces podrá aplicarse la migración pendiente de pagos.

Esta promoción sustituirá la instrucción antigua de exigir una base clonada por el ensayo de esquema vacío autorizado. La guía se actualizará con este procedimiento específico; no se eliminará su advertencia de forma anticipada.

## 4. Fidelidad del esquema y bootstrap

La fuente de la baseline será una captura estructural y un inventario de catálogo PostgreSQL de `public`. No incluirá filas de ventas, contactos, usuarios, permisos personalizados, archivos de Storage ni datos de `auth`/`storage` de Supabase.

El SQL ejecutable excluirá `_prisma_migrations` y cualquier historial administrativo: esa tabla la administra Prisma, no la crea la baseline. También excluirá esquemas QA y objetos administrados por extensiones o por Supabase que no pertenezcan a Auna. El respaldo de esos historiales se conserva por separado; no se confunde con la instalación nueva.

Se preservarán tablas, columnas, tipos, secuencias, defaults, columnas generadas, claves e índices con sus definiciones, CHECKs, funciones, triggers, estado y políticas RLS, permisos relevantes y pertenencia de tablas a publicaciones. La comparación debe usar definiciones, no solamente cantidades. No se copiarán propietarios ni credenciales específicos del proyecto a una instalación nueva.

Las dependencias de plataforma, como los roles de Supabase, extensiones y la publicación Realtime, se identificarán como prerrequisitos. Si falta un requisito se detendrá la instalación con un diagnóstico, sin crear sustitutos que amplíen permisos. No se cambiarán los esquemas administrados por Supabase ni las políticas de Storage.

El diff existente se clasificará antes de tocar modelos: metadata representable que puede alinearse sin cambiar la base, objetos no representables que necesitan SQL propio y cambios funcionales que quedan fuera de esta reconciliación. En concreto:

- Conservar `product_lots.is_system_generated` y sus datos; no eliminarlo para que el diff quede vacío.
- Conservar la expresión generada de `roles.name_key`; no reemplazarla por texto editable ni rellenarla manualmente.
- Conservar las restricciones compuestas que impiden cruces de empresa/sucursal y el vínculo entre contratación y venta.
- No cambiar reglas de borrado, cascadas o nulabilidad como efecto colateral de regenerar SQL.

Se alinearán los mapas de Prisma cuando pueda hacerse sin modificar esos comportamientos. Las diferencias no representables se registrarán individualmente con la definición esperada; no se admitirá ignorar bloques completos de drift. Si aparece una diferencia funcional no cubierta, se mantendrá la pausa y se pedirá una decisión.

Una captura solo de estructura no conserva los INSERT de catálogos de migraciones anteriores. Se inventariarán esos INSERT y se mantendrá el bootstrap de sistema necesario para una instalación nueva, sin copiar datos de empresas. Por ejemplo, `Borrador` debe existir en los estados de venta; actualmente la semilla general solo enumera `Completada` y `Cancelada`. La inicialización de pagos debe conservar los cuatro básicos y las preferencias idempotentes por empresa.

No se ejecutará `prisma/seed.js` sobre la Supabase existente: contiene limpieza de categorías, cambios de caja predeterminada y un alta administrativa heredada con credencial fija. No se legitimará esa credencial ni se ampliará esta entrega a rediseñar el onboarding; el ensayo usará únicamente inicialización de sistema dirigida y actores sintéticos con credenciales aleatorias no publicadas. No se certificará el onboarding general ni el inicio de sesión desde una instancia nueva solo por instalar tablas y pasar ese ensayo.

## 5. Respaldo y controles previos

Antes de cualquier escritura:

- Identificar el destino configurado mediante una huella sin credenciales. Usar la conexión existente y no cambiar `.env`, `DATABASE_URL` ni `DIRECT_URL` globales.
- Capturar esquema, historial completo y respaldo recuperable de las tablas Auna de `public` en una carpeta privada local, excluida de Git y con permisos restringidos. No imprimir datos de negocio, contraseñas ni cadenas de conexión en logs.
- Verificar integridad, checksum y que el formato del respaldo es legible por la herramienta de recuperación. No afirmar que se probó una restauración completa de datos: la autorización del ensayo es de estructura y datos sintéticos, no de clonar clientes.
- Registrar huellas de IDs e importes de relaciones financieras, así como pagos, ventas, cierres, reintegros, configuraciones, roles y membresías. Una comparación solo de cantidades no basta para detectar cambios.
- Comparar otra vez migraciones, checksums y estructura con el manifiesto revisado; abortar si cambiaron o apareció una migración fallida no resuelta.
- Identificar y pausar solo los procesos Auna que estaban activos, según la autorización ya recibida. Confirmar una ventana sin otros escritores/migradores y mantener un bloqueo administrativo durante la promoción. Si no puede garantizarse, detenerse.

No se usará `migrate reset`, `db push`, `TRUNCATE`, borrado de negocios, semilla completa ni edición de filas históricas para resolver divergencias.

## 6. Ensayo en la misma Supabase

Crear un esquema vacío con identificador único `auna_baseline_qa_<uuid>`, generado y registrado antes de usarlo. No crear otro proyecto, otra instancia ni otra base local. Solo se introducirán catálogos de sistema y datos sintéticos propios de la prueba.

La variante del SQL para el ensayo deberá cambiar únicamente el destino de objetos Auna hacia ese esquema. No basta cambiar `search_path`: funciones, triggers, referencias calificadas, políticas y publicaciones también pueden apuntar a `public`. La implementación debe comprobar sus destinos y rechazar sentencias con escrituras fuera del esquema de ensayo. Si una sentencia de plataforma no puede aislarse, se validará de solo lectura o se mantendrá como bloqueo; no se ejecutará sobre `public` bajo la etiqueta de ensayo.

Se probarán estas condiciones:

1. Instalación desde vacío de la baseline y de la migración de pagos, usando la cadena SQL, sin `db push`.
2. Equivalencia del inventario de baseline con la estructura real previa, normalizando solo el nombre del esquema y diferencias ambientales declaradas.
3. Funcionamiento de CHECKs, índices especiales, snapshots comerciales, columnas generadas y guards mediante intentos válidos e inválidos. Cada intento negativo se revertirá aun si inesperadamente fue aceptado.
4. Bootstrap de sistema suficiente para las pruebas de catálogos, borradores y roles; no creación de un administrador con contraseña conocida.
5. Segunda ejecución de deploy sin cambios y baseline marcada como aplicada sin recrear tablas existentes.
6. Ensayo del cambio de historial y recuperación con metadata sintética: interrupción antes/después del movimiento, antes/después del registro y reanudación sin sobrescrituras.

Los permisos y publicaciones se compararán de forma separada: no se añadirá el esquema QA a la publicación Realtime real ni se expondrá a clientes. El ensayo no certifica conexiones externas, Storage ni FEL.

La limpieza solo eliminará el esquema QA exacto registrado por esa ejecución, tras verificar identidad y contenido. Nunca usará un prefijo genérico ni tocará `public`, `auth`, `storage` o `auna_migration_audit`. Si falla, informará el identificador y detendrá la promoción hasta resolverlo.

## 7. Promoción y recuperación

Solo después del ensayo, revisión y respaldo válidos:

1. Revalidar huellas y pausa de escritores, y registrar una fase de promoción recuperable.
2. Archivar de forma transaccional la tabla original del historial en el esquema administrativo; verificar que todas sus filas y definiciones siguen intactas.
3. Registrar la baseline mediante Prisma. Su coincidencia con el esquema previo debe estar probada antes de marcarla como aplicada.
4. Comprobar el estado nativo de Prisma: baseline aplicada y únicamente pagos pendiente. No usar un filtro que esconda nombres históricos para simular un estado limpio.
5. Aplicar `202610150002_company_payment_methods` por el procedimiento oficial y generar Prisma Client. No registrar esa migración como aplicada sin ejecutar y verificar su SQL.
6. Repetir estado y deploy. El segundo deploy no modifica preferencias ni historial financiero.
7. Ejecutar la integración opt-in de pagos ya preparada; limpiar exclusivamente sus fixtures y comparar las huellas de negocio previas y posteriores. Los cambios permitidos son los de metadata, los básicos que faltaran y las preferencias definidos en el SQL de pagos.
8. Restablecer únicamente los procesos Auna que estaban activos y continuar la validación de API y de interfaz pendiente del plan de pagos.

Un fallo mantiene Auna pausado. Antes de aplicar pagos, la recuperación puede devolver el historial original al lugar inicial únicamente si se comprueba que no hubo otra migración ni un escritor concurrente; se conservará también cualquier metadata nueva creada durante el intento. No se eliminará una tabla desconocida ni se restaurará un respaldo sobre datos cambiados automáticamente.

Después de aplicar pagos no se volverá al backend antiguo que muta métodos globales ni se ejecutará una migración inversa improvisada. Se mantendrá la pausa, se conservarán ambos historiales y se diagnosticará si procede reparación hacia adelante o una recuperación específica con aprobación del usuario. Si el fallo ocurre después del commit pero antes de recibir confirmación, primero se comprobarán esquema e historial: no se repetirá ciegamente el cambio.

## 8. Entregables y aceptación

- Baseline, archivo histórico íntegro, manifiesto estructural y procedencia versionados, sin respaldos ni secretos en Git.
- Procedimiento de promoción/recuperación, herramientas de comprobación, adaptación de los consumidores de archivos históricos y pruebas reproducibles.
- Guía de despliegue actualizada solo cuando la reconciliación haya sido verificada; registro de qué cambios fueron realmente ejecutados.
- Suites locales, validación de Prisma, ensayo aislado, pruebas financieras y limpieza con resultados registrados. Las nuevas escrituras de herramientas críticas y sus fallos requieren regresiones observadas fallar y luego pasar.
- Estado nativo de migraciones sin divergencia después de la promoción y pagos, sin perder el historial anterior auditable.
- Estructura nueva instalable y guardada sin perder resguardos propios; datos existentes intactos salvo la metadata autorizada de pagos. La semilla general y el onboarding completo siguen fuera de la certificación.
- Ningún esquema QA residual, instancia nueva, cambio de permisos de negocio ni escritura no autorizada en esquemas Supabase.

La tarea 9 de métodos de pago permanece incompleta hasta desplegar, ejecutar su integración y terminar las verificaciones visuales pendientes. Esta especificación no la da por finalizada.

## Referencias

- [Prisma v6: baselining](https://docs.prisma.io/docs/orm/v6/prisma-migrate/workflows/baselining).
- [Prisma v6: squashing y preservación de SQL propio](https://docs.prisma.io/docs/orm/v6/prisma-migrate/workflows/squashing-migrations).
- `docs/DEPLOYMENT_AND_MIGRATIONS.md`: bloqueo previo y precauciones vigentes.
- `deposito-frontend/docs/superpowers/plans/2026-10-15-metodos-pago-por-empresa.md`: plan cuyo despliegue se desbloqueará.

## Revisión del diseño

Comprobados alcance, consistencia y ausencia de pasos de implementación implícitos. La baseline precede a pagos; el archivo de SQL anterior no es ejecutable por deploy; la tabla histórica se conserva; las pruebas temporales no escriben negocios reales; el historial solo se promueve tras un ensayo seguro. No se ha creado el esquema temporal, movido historial, cambiado migraciones activas ni escrito en la base durante la preparación de este documento.
