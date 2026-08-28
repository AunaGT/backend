/**
 * Qué permiso arrastra a cuál. Nadie que pueda EDITAR algo debería quedarse sin
 * poder VERLO, y ninguna pantalla debería abrirse para chocar con un 403 en la
 * primera consulta que hace. La expansión se hace en el servidor (al guardar el
 * rol, al armar la sesión y en el token), así los roles viejos y los que se
 * crean por API o seed también quedan coherentes, no solo lo que se marque en
 * la pantalla de roles.
 *
 * Cada línea sale de lo que la pantalla pide de verdad; el comentario dice
 * cuál, para que se pueda revisar cuando algo cambie.
 */

/** code → permisos que otorga implícitamente. */
const IMPLIES = {
  // --- Usuarios y roles -----------------------------------------------------
  // El alta y la edición traen selector de rol (GET /auth/roles).
  'users.create': ['users.view', 'roles.view'],
  'users.edit': ['users.view', 'roles.view'],
  'users.delete': ['users.view'],
  'users.import': ['users.view', 'users.create', 'roles.view'],
  'roles.manage': ['roles.view'],

  // --- Empresas y sucursales ------------------------------------------------
  // /sucursales monta la tarjeta de almacenes de la sucursal activa.
  'branches.manage': ['branches.view_all', 'warehouses.view'],
  'companies.manage': ['branches.manage', 'branches.view_all', 'warehouses.view'],

  // --- Almacenes y movimientos ---------------------------------------------
  'warehouses.manage': ['warehouses.view'],
  // El libro y el alta de movimientos muestran ubicación y producto en cada fila.
  'stock_moves.view': ['warehouses.view', 'products.view'],
  'stock_moves.create': ['stock_moves.view', 'warehouses.view', 'products.view'],
  'stock_moves.adjust': ['stock_moves.view', 'warehouses.view', 'products.view'],

  // --- Traslados ------------------------------------------------------------
  'transfers.view': ['products.view'],
  'transfers.create': ['transfers.view', 'products.view'],
  // Al recibir se elige la ubicación de destino.
  'transfers.receive': ['transfers.view', 'warehouses.view'],
  'transfers.cancel': ['transfers.view'],

  // --- Inventario -----------------------------------------------------------
  // /inventario abre con la barra de alcance (sucursal · almacén · ubicación) y
  // el desglose por ubicación de cada producto.
  'products.view': ['warehouses.view'],
  // El formulario de producto tiene selector de proveedor.
  'products.create': ['products.view', 'contacts.suppliers.view'],
  'products.edit': ['products.view', 'contacts.suppliers.view'],
  'products.delete': ['products.view'],
  'products.import': ['products.view', 'products.create', 'contacts.suppliers.view'],
  'products.export': ['products.view'],
  // Registrar ingreso: proveedor, productos, y a qué ubicación entra.
  'products.register_incoming': [
    'products.view', 'merchandise.view', 'contacts.suppliers.view', 'warehouses.view',
  ],

  // --- Inventariado ---------------------------------------------------------
  'inventory_count.view': ['products.view', 'warehouses.view'],
  // El alcance de la sesión se arma por categoría, proveedor y almacén.
  'inventory_count.create': [
    'inventory_count.view', 'products.view', 'warehouses.view', 'contacts.suppliers.view',
  ],
  'inventory_count.count': ['inventory_count.view'],
  'inventory_count.submit': ['inventory_count.view', 'inventory_count.count'],
  'inventory_count.approve': ['inventory_count.view'],
  'inventory_count.cancel': ['inventory_count.view'],
  'inventory_count.export': ['inventory_count.view'],

  // --- Contactos ------------------------------------------------------------
  'contacts.suppliers.create': ['contacts.suppliers.view'],
  'contacts.suppliers.edit': ['contacts.suppliers.view'],
  'contacts.suppliers.delete': ['contacts.suppliers.view'],
  'contacts.suppliers.import': ['contacts.suppliers.view', 'contacts.suppliers.create'],
  'contacts.clients.create': ['contacts.clients.view'],
  'contacts.clients.edit': ['contacts.clients.view'],
  'contacts.clients.delete': ['contacts.clients.view'],

  // --- Ventas y documentos --------------------------------------------------
  // El POS busca productos, elige cliente y consulta de qué ubicación despacha.
  'sales.create': ['sales.view', 'products.view', 'warehouses.view', 'contacts.clients.view'],
  'sales.view_detail': ['sales.view'],
  'sales.view_invoice': ['sales.view'],
  'sales.cancel': ['sales.view', 'sales.view_detail'],
  'quotes.create': ['quotes.view', 'products.view', 'contacts.clients.view'],
  'quotes.manage': ['quotes.view'],
  'orders.create': ['orders.view', 'products.view', 'contacts.clients.view'],
  'orders.manage': ['orders.view'],
  'returns.manage': ['returns.view', 'sales.view', 'sales.view_detail', 'products.view'],

  // --- Cartera --------------------------------------------------------------
  // La cartera es una lista de clientes: sin verlos no se puede navegar a nadie.
  'receivables.view': ['contacts.clients.view'],
  'receivables.manage': ['receivables.view', 'contacts.clients.view'],
  'receivables.adjust': ['receivables.view', 'contacts.clients.view'],
  // Autorizar por encima del límite implica poder consultarlo.
  'sales.credit.override': ['receivables.view'],

  // --- Caja -----------------------------------------------------------------
  'cashclosure.create': ['cashclosure.view'],
  'cashclosure.create_day': ['cashclosure.view', 'cashclosure.create'],
  'cashclosure.create_own': ['cashclosure.view', 'cashclosure.create'],
  'cashclosure.approve': ['cashclosure.view'],
  'cashclosure.validate': ['cashclosure.view'],

  // --- Mercancía ------------------------------------------------------------
  // La lista filtra por proveedor.
  'merchandise.view': ['contacts.suppliers.view'],
  'merchandise.details': ['merchandise.view'],
  'merchandise.reports': ['merchandise.view'],
  'merchandise.mark_paid': ['merchandise.view', 'merchandise.details'],

  // --- Resto ----------------------------------------------------------------
  'catalogs.manage': ['catalogs.view'],
  'settings.manage': ['settings.view'],
  'alerts.manage': ['alerts.view'],
  // El armado de una promoción elige productos y categorías.
  'promotions.manage': ['promotions.view', 'products.view'],
  // El modal de reportes acota por almacén.
  'reports.view': ['warehouses.view'],
  // El escáner resuelve el código contra el catálogo.
  'scanner.view': ['products.view'],
  'accounting.create': ['accounting.view'],
  'accounting.manage': ['accounting.view', 'accounting.create'],
}

/**
 * Cierra la lista con todo lo que arrastra, en cascada (manage → view → …).
 * @param {Iterable<string>} codes
 * @returns {string[]} sin repetidos
 */
function expandPermissions(codes) {
  const out = new Set()
  const pending = [...(codes || [])].map(String)
  while (pending.length) {
    const code = pending.pop()
    if (!code || out.has(code)) continue
    out.add(code)
    for (const implied of IMPLIES[code] || []) pending.push(implied)
  }
  return [...out]
}

module.exports = { IMPLIES, expandPermissions }
