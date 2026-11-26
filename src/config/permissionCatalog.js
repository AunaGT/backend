// Installation catalog, shared by the seed and dependency tests. Importing it never connects to a database.
const permissions = [
  ...require('../modules/appointments/permissions').permissions,
  ...require('../modules/integrations/permissions').permissions,
  ...require('../modules/config/hardware/seed').permissions,
  // Usuarios y Roles
  { code: 'users.view', name: 'Ver usuarios', description: 'Puede listar y ver usuarios' },
  { code: 'users.create', name: 'Crear usuarios', description: 'Puede crear nuevos usuarios' },
  { code: 'users.edit', name: 'Editar usuarios', description: 'Puede editar datos de usuarios' },
  { code: 'users.delete', name: 'Eliminar usuarios', description: 'Puede eliminar usuarios' },
  { code: 'users.import', name: 'Importar usuarios', description: 'Puede importar usuarios desde archivos' },
  { code: 'roles.view', name: 'Ver roles', description: 'Puede ver roles disponibles' },
  { code: 'roles.manage', name: 'Gestionar roles y permisos', description: 'Puede crear, editar y asignar permisos a roles' },

  // Empresas y sucursales
  { code: 'companies.manage', name: 'Gestionar empresas', description: 'Puede crear y editar empresas y asignar usuarios' },
  { code: 'branches.manage', name: 'Gestionar sucursales', description: 'Puede crear y editar sucursales y asignar usuarios' },
  { code: 'branches.view_all', name: 'Vista consolidada de sucursales', description: 'Puede ver reportes y datos de todas las sucursales de la empresa' },
  { code: 'transfers.view', name: 'Ver traslados', description: 'Puede ver traslados entre sucursales' },
  { code: 'transfers.create', name: 'Crear traslados', description: 'Puede enviar mercancía a otra sucursal' },
  { code: 'transfers.receive', name: 'Recibir traslados', description: 'Puede confirmar la recepción de traslados' },
  { code: 'transfers.cancel', name: 'Cancelar traslados', description: 'Puede cancelar traslados en tránsito' },
  { code: 'warehouses.view', name: 'Ver almacenes', description: 'Puede ver almacenes y ubicaciones' },
  { code: 'warehouses.manage', name: 'Gestionar almacenes', description: 'Puede crear y editar almacenes y ubicaciones' },
  { code: 'stock_moves.view', name: 'Ver movimientos', description: 'Puede ver movimientos internos y kardex' },
  { code: 'stock_moves.create', name: 'Mover mercancía', description: 'Puede mover mercancía entre ubicaciones' },
  { code: 'stock_moves.adjust', name: 'Ajustar existencias', description: 'Puede corregir existencias sin documento (merma, daño)' },

  // RRHH
  { code: 'hr.deductions.view', name: 'Ver descuentos de salario', description: 'Puede consultar descuentos manuales y su historial' },
  { code: 'hr.deductions.manage', name: 'Gestionar descuentos de salario', description: 'Puede registrar, editar y cancelar descuentos pendientes' },
  { code: 'hr.employees.view', name: 'Ver empleados', description: 'Puede ver el expediente de los empleados' },
  { code: 'hr.documents.view', name: 'Ver documentos de empleados', description: 'Puede abrir y descargar documentos privados del expediente' },
  { code: 'hr.documents.manage', name: 'Gestionar documentos de empleados', description: 'Puede cargar y reemplazar documentos del expediente' },
  { code: 'hr.documents.archive', name: 'Archivar documentos de empleados', description: 'Puede archivar y restaurar versiones del expediente' },
  { code: 'hr.employees.create', name: 'Crear empleados', description: 'Puede dar de alta empleados' },
  { code: 'hr.employees.edit', name: 'Editar empleados', description: 'Puede editar el expediente de los empleados' },
  { code: 'hr.employees.delete', name: 'Dar de baja empleados', description: 'Puede dar de baja empleados' },
  { code: 'hr.attendance.view', name: 'Ver asistencia', description: 'Puede consultar el registro de asistencia' },
  { code: 'hr.attendance.manage', name: 'Registrar asistencia', description: 'Puede marcar entradas, salidas y horas extra' },
  { code: 'hr.advances.view', name: 'Ver anticipos', description: 'Puede consultar los anticipos de sueldo' },
  { code: 'hr.advances.manage', name: 'Gestionar anticipos', description: 'Puede otorgar y cancelar anticipos de sueldo' },

  // Nómina
  { code: 'payroll.view', name: 'Ver planillas', description: 'Puede ver las planillas y sus recibos' },
  { code: 'payroll.create', name: 'Generar planillas', description: 'Puede generar y recalcular planillas en borrador' },
  { code: 'payroll.confirm', name: 'Confirmar planillas', description: 'Puede confirmar una planilla y descontar anticipos' },
  { code: 'payroll.pay', name: 'Pagar planillas', description: 'Puede marcar una planilla como pagada' },
  { code: 'payroll.cancel', name: 'Anular planillas', description: 'Puede anular una planilla en borrador o confirmada' },

  // Cuentas por cobrar (cartera)
  { code: 'receivables.view', name: 'Ver cartera', description: 'Puede ver la cartera, el estado de cuenta y la antigüedad de saldos' },
  { code: 'receivables.manage', name: 'Registrar cobros', description: 'Puede registrar cobros, aplicar anticipos y prorrogar vencimientos; no anula cobros' },
  { code: 'receivables.cancel_payment', name: 'Anular cobros de clientes', description: 'Puede eliminar un cobro y restaurar los saldos afectados; requiere revisar su efecto contable' },
  { code: 'receivables.adjust', name: 'Ajustar cartera', description: 'Puede emitir notas de crédito y castigar cuentas incobrables' },
  { code: 'sales.credit.override', name: 'Autorizar crédito excedido', description: 'Puede autorizar una venta al crédito que excede el límite del cliente o que tiene facturas vencidas' },

  // Productos e inventario
  { code: 'products.view', name: 'Ver productos', description: 'Puede ver el catálogo de productos' },
  { code: 'products.create', name: 'Crear productos', description: 'Puede crear productos' },
  { code: 'products.edit', name: 'Editar productos', description: 'Puede editar productos' },
  { code: 'products.view_costs', name: 'Consultar costos y márgenes del catálogo', description: 'Puede consultar costos, costos congelados y valoraciones en inventario y documentos operativos; no concede edición ni exportación' },
  { code: 'products.packages.publish', name: 'Activar versiones de paquetes', description: 'Puede validar y activar un paquete para ofrecerlo en nuevas cotizaciones' },
  { code: 'products.packages.archive', name: 'Archivar paquetes', description: 'Puede retirar paquetes de nuevas cotizaciones; conserva acuerdos anteriores' },
  { code: 'products.delete', name: 'Eliminar productos', description: 'Puede eliminar productos' },
  { code: 'products.register_incoming', name: 'Registrar ingreso de mercancía', description: 'Puede registrar ingresos de mercancía desde proveedores' },
  { code: 'products.import', name: 'Importar productos', description: 'Puede realizar importaciones masivas de productos' },
  { code: 'products.export', name: 'Exportar productos', description: 'Puede exportar listados de productos' },

  // Inventariado (conteo físico)
  { code: 'inventory_count.view', name: 'Ver inventariados', description: 'Puede ver sesiones y líneas de inventariado' },
  { code: 'inventory_count.create', name: 'Crear inventariado', description: 'Puede crear sesiones e iniciar conteo' },
  { code: 'inventory_count.count', name: 'Registrar conteos', description: 'Puede ingresar cantidades contadas físicamente' },
  { code: 'inventory_count.submit', name: 'Enviar inventariado a revisión', description: 'Puede cerrar el conteo y enviar a revisión' },
  { code: 'inventory_count.approve', name: 'Aprobar inventariado', description: 'Puede aprobar y aplicar ajustes de stock' },
  { code: 'inventory_count.cancel', name: 'Cancelar inventariado', description: 'Puede cancelar sesiones sin aplicar cambios' },
  { code: 'inventory_count.export', name: 'Exportar reportes de inventariado', description: 'Puede exportar CSV/PDF de sesiones de inventario' },

  // Contactos — proveedores (tabla suppliers, party_type SUPPLIER)
  { code: 'contacts.suppliers.view', name: 'Ver proveedores', description: 'Puede ver contactos tipo proveedor' },
  { code: 'contacts.suppliers.create', name: 'Crear proveedores', description: 'Puede crear contactos tipo proveedor' },
  { code: 'contacts.suppliers.edit', name: 'Editar proveedores', description: 'Puede editar contactos tipo proveedor' },
  { code: 'contacts.suppliers.delete', name: 'Eliminar proveedores', description: 'Puede eliminar contactos tipo proveedor' },
  { code: 'contacts.suppliers.import', name: 'Importar proveedores', description: 'Puede importar proveedores desde archivos' },
  // Contactos — clientes (tabla suppliers, party_type CUSTOMER)
  { code: 'contacts.clients.view', name: 'Ver clientes', description: 'Puede ver contactos tipo cliente' },
  { code: 'contacts.clients.create', name: 'Crear clientes', description: 'Puede crear contactos tipo cliente' },
  { code: 'contacts.clients.edit', name: 'Editar clientes', description: 'Puede editar contactos tipo cliente' },
  { code: 'contacts.clients.delete', name: 'Eliminar clientes', description: 'Puede eliminar contactos tipo cliente' },

  // Ventas y devoluciones
  { code: 'sales.view', name: 'Ver ventas', description: 'Puede ver ventas' },
  { code: 'sales.view_detail', name: 'Ver detalle de venta', description: 'Puede ver el detalle de una venta' },
  { code: 'sales.view_invoice', name: 'Ver factura', description: 'Puede consultar la factura de una venta' },
  { code: 'sales.create', name: 'Crear ventas', description: 'Puede registrar nuevas ventas' },
  { code: 'sales.cancel', name: 'Anular / actualizar ventas', description: 'Puede anular o actualizar ventas' },
  { code: 'sales.fiscal.register', name: 'Solicitar facturación electrónica', description: 'Solicitar la factura de una venta confirmada; no concede cobros ni certificación manual' },

  // Cotizaciones
  { code: 'quotes.view', name: 'Ver cotizaciones', description: 'Puede ver cotizaciones comerciales' },
  { code: 'quotes.create', name: 'Crear cotizaciones', description: 'Puede crear y editar cotizaciones en borrador' },
  { code: 'quotes.manage', name: 'Gestionar cotizaciones', description: 'Puede enviar, aceptar, rechazar y convertir cotizaciones' },

  // Pedidos
  { code: 'orders.view', name: 'Ver pedidos', description: 'Puede ver pedidos comerciales' },
  { code: 'orders.create', name: 'Crear pedidos', description: 'Puede crear pedidos en borrador' },
  { code: 'orders.manage', name: 'Gestionar pedidos', description: 'Puede confirmar, cancelar y convertir pedidos a venta' },

  { code: 'returns.view', name: 'Ver devoluciones', description: 'Puede ver devoluciones' },
  { code: 'returns.manage', name: 'Solicitar devoluciones', description: 'Puede crear solicitudes; no autoriza aprobar, rechazar ni liquidar devoluciones' },
  { code: 'returns.approve', name: 'Aprobar o rechazar devoluciones', description: 'Puede revisar la resolución de una devolución sin mover inventario ni dinero' },
  { code: 'returns.complete', name: 'Recibir y liquidar devoluciones', description: 'Puede completar devoluciones aprobadas, mover inventario y registrar su liquidación' },
  { code: 'returns.override_policy', name: 'Autorizar devoluciones fuera de plazo', description: 'Puede justificar excepciones de plazo cuando la política de la empresa las permite; no aprueba ni liquida solicitudes' },

  // Cierre de caja
  ...require('../modules/cash-closure/permissions').permissions,
  ...require('../modules/cash-closure/permissions').movementPermissions,
  ...require('../modules/cash-closure/permissions').custodyPermissions,
  ...require('../modules/cash-closure/permissions').policyPermissions,
  ...require('../modules/cash-closure/permissions').noticePermissions,
  ...require('../modules/cash-closure/permissions').settlementPermissions,
  ...require('../modules/cash-closure/permissions').dailyPermissions,
  ...require('../modules/cash-closure/permissions').closureReadPermissions,
  ...require('../modules/cash-closure/permissions').correctionPermissions,
  ...require('../modules/cash-closure/permissions').disputePermissions,
  { code: 'cashclosure.create', name: 'Crear cierres de caja', description: 'Puede crear cierres (acceso completo: día y propio)' },
  { code: 'cashclosure.create_day', name: 'Generar cierre del día', description: 'Puede generar cierre del día (todos los cajeros)' },
  { code: 'cashclosure.create_own', name: 'Generar solo mi cierre', description: 'Puede generar solo su cierre (cajero)' },
  { code: 'cashclosure.approve', name: 'Aprobar/Rechazar cierres', description: 'Puede aprobar o rechazar cierres de caja' },
  { code: 'cashclosure.validate', name: 'Validar cierres de caja', description: 'Puede validar y cerrar cierres de caja' },

  // Catálogos, condiciones de pago, categorías
  { code: 'catalogs.view', name: 'Ver datos maestros', description: 'Puede ver datos maestros (categorías, términos de pago, etc.)' },
  { code: 'catalogs.manage', name: 'Gestionar datos maestros', description: 'Puede crear y editar datos maestros (categorías, términos de pago, etc.)' },

  // Configuración del sistema
  ...require('../modules/fiscal/permissions').permissions,
  ...require('../modules/config/documentTemplates/permissions').permissions,
  ...require('../modules/config/customerPages/permissions').permissions,
  { code: 'settings.view', name: 'Ver configuración', description: 'Puede ver la configuración del sistema' },
  { code: 'settings.manage', name: 'Gestionar configuración', description: 'Puede modificar configuración (denominaciones, moneda, empresa)' },

  // Alertas y analítica
  { code: 'alerts.view', name: 'Ver alertas', description: 'Puede ver alertas de stock y sistema' },
  { code: 'alerts.manage', name: 'Gestionar alertas', description: 'Puede resolver y reasignar alertas' },
  { code: 'analytics.view', name: 'Ver analítica', description: 'Puede ver paneles de analítica' },
  { code: 'reports.view', name: 'Ver reportes', description: 'Puede ver y generar reportes' },
  { code: 'scanner.view', name: 'Usar escáner', description: 'Puede usar el escáner de códigos de barras' },

  // Promociones
  { code: 'promotions.view', name: 'Ver promociones', description: 'Puede ver promociones' },
  { code: 'promotions.manage', name: 'Gestionar promociones', description: 'Puede crear y administrar promociones' },

  // Mercancía (Registro de ingresos)
  { code: 'merchandise.view', name: 'Ver registros de mercancía', description: 'Puede ver el historial de ingresos de mercancía' },
  { code: 'merchandise.details', name: 'Ver detalles de mercancía', description: 'Puede ver detalles completos de registros de mercancía' },
  { code: 'merchandise.reports', name: 'Generar reportes de mercancía', description: 'Puede generar reportes de ingresos de mercancía' },
  {
    code: 'merchandise.mark_paid',
    name: 'Marcar pago de mercancía',
    description: 'Puede actualizar término de pago, estado y fechas de pago en registros de ingreso',
  },

  // Contabilidad
  { code: 'reports.financial', name: 'Consultar reportes financieros y valorizados', description: 'Permite consultar costos, márgenes y valorizaciones en reportes; también requiere el permiso base del reporte' },
  { code: 'merchandise.cancel_payment', name: 'Anular pagos a proveedores', description: 'Puede anular comprobantes y abonos anteriores de compras' },
  { code: 'merchandise.correct_payment', name: 'Corregir liquidaciones históricas', description: 'Puede corregir saldos históricos con motivo y control de versión; no registra nuevos abonos' },
  { code: 'accounting.view', name: 'Ver contabilidad', description: 'Puede consultar libros y reportes contables' },
  { code: 'accounting.create', name: 'Registrar asientos', description: 'Puede crear asientos manuales, anular y contabilizar operaciones' },
  { code: 'accounting.manage', name: 'Administrar contabilidad', description: 'Puede gestionar catálogo de cuentas, períodos y cierre anual' },
]

async function registerPermissions(db) {
  for (const permission of permissions) {
    await db.permission.upsert({ where: { code: permission.code }, update: { name: permission.name, description: permission.description }, create: permission })
  }
}
async function registerPermissionsForAdmin(db) {
  return db.$transaction(async tx => {
    const admin = await tx.role.findUnique({ where: { system_key: 'ADMIN' } })
    if (!require('../modules/users/roles/policy').isSystemAdmin(admin)) throw new Error('Normaliza el admin global protegido antes de registrar permisos')
    await registerPermissions(tx)
    const registered = await tx.permission.findMany({ select: { id: true } })
    await tx.rolePermission.createMany({ data: registered.map(p => ({ role_id: admin.id, permission_id: p.id })), skipDuplicates: true })
    return { permissions: registered.length, adminRoleId: admin.id }
  }, { maxWait: 10000, timeout: 30000 })
}
module.exports = { permissions, registerPermissions, registerPermissionsForAdmin }
