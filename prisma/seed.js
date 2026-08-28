/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

// El .env no se carga solo cuando esto corre con `node` (index.js sí lo hace).
require('dotenv/config')
const { PrismaClient } = require('@prisma/client')
const { seedChartOfAccounts } = require('../src/services/accounting/seedChartOfAccounts')
const prisma = new PrismaClient()

// Mismos ids que la migración 20260811120000_multi_company_branches, para que
// un seed sobre una base ya migrada no duplique la empresa principal.
const DEFAULT_COMPANY_ID = '00000000-0000-4000-8000-000000000001'
const DEFAULT_BRANCH_ID = '00000000-0000-4000-8000-000000000002'

async function main() {
  console.log('Iniciando seed de base de datos...')

  // ========================================
  // 0. EMPRESA Y SUCURSAL PRINCIPAL
  // ========================================
  const company = await prisma.company.upsert({
    where: { id: DEFAULT_COMPANY_ID },
    update: {},
    create: { id: DEFAULT_COMPANY_ID, name: 'Mi Empresa', code: 'PRIN', is_default: true },
  })
  await prisma.branch.upsert({
    where: { id: DEFAULT_BRANCH_ID },
    update: {},
    create: { id: DEFAULT_BRANCH_ID, company_id: company.id, name: 'Principal', code: 'PRIN', is_default: true },
  })
  console.log('  Empresa y sucursal principal listas')

  // ========================================
  // 1. ROLES
  // ========================================
  console.log('Creando roles...')
  const roles = ['admin']
  await prisma.role.createMany({ 
    data: roles.map(name => ({ name })), 
    skipDuplicates: true 
  })
  console.log('Roles creados')

  // ========================================
  // 2. CATÁLOGOS - CATEGORÍAS DE PRODUCTOS (limpieza de categorías sin uso)
  // ========================================
  const oldCategories = await prisma.productCategory.findMany()

  for (const cat of oldCategories) {
    const linkedProducts = await prisma.product.count({ where: { category_id: cat.id } })
    const linkedSuppliers = await prisma.supplierCategory.count({ where: { category_id: cat.id } })

    if (linkedProducts === 0 && linkedSuppliers === 0) {
      try {
        await prisma.productCategory.delete({ where: { id: cat.id } })
        console.log(`  Eliminada categoría antigua: ${cat.name}`)
      } catch (err) {
        console.log(`  No se pudo eliminar categoría '${cat.name}': ${err.message}`)
      }
    }
  }
  console.log('Categorías de productos creadas')

  // ========================================
  // 3. CATÁLOGOS - ESTADOS Y STATUS
  // ========================================
  console.log('Creando estados y status...')
  const statuses = ['Activa', 'Resuelta', 'Pendiente']
  const stockStatuses = ['Disponible', 'Bajo', 'Agotado']
  const saleStatuses = ['Completada', 'Cancelada']
  // is_credit marca los que generan cuenta por cobrar en vez de entrar a caja
  const paymentMethods = [
    { name: 'Efectivo', is_credit: false },
    { name: 'Tarjeta', is_credit: false },
    { name: 'Transferencia', is_credit: false },
    { name: 'Crédito', is_credit: true },
  ]
  const alertTypes = ['Stock Bajo', 'Sin Stock', 'Vencimiento', 'Precio']
  const alertPriorities = ['Baja', 'Media', 'Alta', 'Crítica']
  const returnStatuses = ['Pendiente', 'Aprobada', 'Rechazada', 'Completada']

  await prisma.status.createMany({ data: statuses.map(name => ({ name })), skipDuplicates: true })
  await prisma.stockStatus.createMany({ data: stockStatuses.map(name => ({ name })), skipDuplicates: true })
  await prisma.paymentMethod.createMany({ data: paymentMethods, skipDuplicates: true })
  // skipDuplicates deja intacto un «Crédito» preexistente sin la bandera, que es
  // justo el caso de las empresas que ya lo habían creado a mano.
  await prisma.paymentMethod.updateMany({ where: { name: 'Crédito' }, data: { is_credit: true } })
  await prisma.saleStatus.createMany({ data: saleStatuses.map(name => ({ name })), skipDuplicates: true })
  await prisma.alertType.createMany({ data: alertTypes.map(name => ({ name })), skipDuplicates: true })
  await prisma.alertPriority.createMany({ data: alertPriorities.map(name => ({ name })), skipDuplicates: true })
  await prisma.returnStatus.createMany({ data: returnStatuses.map(name => ({ name })), skipDuplicates: true })
  console.log('Estados y status creados')

  // ========================================
  // 4. PERMISOS - SISTEMA RBAC
  // ========================================
  console.log('Creando permisos del sistema...')
  
  const permissions = [
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
    { code: 'hr.employees.view', name: 'Ver empleados', description: 'Puede ver el expediente de los empleados' },
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
    { code: 'receivables.manage', name: 'Registrar cobros', description: 'Puede registrar y eliminar cobros de clientes, aplicar anticipos y prorrogar vencimientos' },
    { code: 'receivables.adjust', name: 'Ajustar cartera', description: 'Puede emitir notas de crédito y castigar cuentas incobrables' },
    { code: 'sales.credit.override', name: 'Autorizar crédito excedido', description: 'Puede autorizar una venta al crédito que excede el límite del cliente o que tiene facturas vencidas' },

    // Productos e inventario
    { code: 'products.view', name: 'Ver productos', description: 'Puede ver el catálogo de productos' },
    { code: 'products.create', name: 'Crear productos', description: 'Puede crear productos' },
    { code: 'products.edit', name: 'Editar productos', description: 'Puede editar productos' },
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

    // Cotizaciones
    { code: 'quotes.view', name: 'Ver cotizaciones', description: 'Puede ver cotizaciones comerciales' },
    { code: 'quotes.create', name: 'Crear cotizaciones', description: 'Puede crear y editar cotizaciones en borrador' },
    { code: 'quotes.manage', name: 'Gestionar cotizaciones', description: 'Puede enviar, aceptar, rechazar y convertir cotizaciones' },

    // Pedidos
    { code: 'orders.view', name: 'Ver pedidos', description: 'Puede ver pedidos comerciales' },
    { code: 'orders.create', name: 'Crear pedidos', description: 'Puede crear pedidos en borrador' },
    { code: 'orders.manage', name: 'Gestionar pedidos', description: 'Puede confirmar, cancelar y convertir pedidos a venta' },

    { code: 'returns.view', name: 'Ver devoluciones', description: 'Puede ver devoluciones' },
    { code: 'returns.manage', name: 'Gestionar devoluciones', description: 'Puede crear y cambiar estado de devoluciones' },

    // Cierre de caja
    { code: 'cashclosure.view', name: 'Ver cierres de caja', description: 'Puede ver cierres de caja' },
    { code: 'cashclosure.create', name: 'Crear cierres de caja', description: 'Puede crear cierres (acceso completo: día y propio)' },
    { code: 'cashclosure.create_day', name: 'Generar cierre del día', description: 'Puede generar cierre del día (todos los cajeros)' },
    { code: 'cashclosure.create_own', name: 'Generar solo mi cierre', description: 'Puede generar solo su cierre (cajero)' },
    { code: 'cashclosure.approve', name: 'Aprobar/Rechazar cierres', description: 'Puede aprobar o rechazar cierres de caja' },
    { code: 'cashclosure.validate', name: 'Validar cierres de caja', description: 'Puede validar y cerrar cierres de caja' },

    // Catálogos, condiciones de pago, categorías
    { code: 'catalogs.view', name: 'Ver datos maestros', description: 'Puede ver datos maestros (categorías, términos de pago, etc.)' },
    { code: 'catalogs.manage', name: 'Gestionar datos maestros', description: 'Puede crear y editar datos maestros (categorías, términos de pago, etc.)' },

    // Configuración del sistema
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
    { code: 'accounting.view', name: 'Ver contabilidad', description: 'Puede consultar libros y reportes contables' },
    { code: 'accounting.create', name: 'Registrar asientos', description: 'Puede crear asientos manuales, anular y contabilizar operaciones' },
    { code: 'accounting.manage', name: 'Administrar contabilidad', description: 'Puede gestionar catálogo de cuentas, períodos y cierre anual' },
  ]

  // Crear todos los permisos (idempotente)
  for (const perm of permissions) {
    await prisma.permission.upsert({
      where: { code: perm.code },
      update: {
        name: perm.name,
        description: perm.description,
      },
      create: perm,
    })
  }
  console.log('Permisos creados')

  // Migrar permisos legacy a su código vigente (roles que ya los tenían)
  const legacyPermissionMigrations = [
    ['suppliers.view', 'contacts.suppliers.view'],
    ['suppliers.create', 'contacts.suppliers.create'],
    ['suppliers.edit', 'contacts.suppliers.edit'],
    ['suppliers.delete', 'contacts.suppliers.delete'],
    ['suppliers.import', 'contacts.suppliers.import'],
    // merchandise.register era un duplicado muerto: la UI y las rutas usan products.register_incoming
    ['merchandise.register', 'products.register_incoming'],
  ]
  for (const [oldCode, newCode] of legacyPermissionMigrations) {
    const oldP = await prisma.permission.findUnique({ where: { code: oldCode } })
    const newP = await prisma.permission.findUnique({ where: { code: newCode } })
    if (!oldP || !newP) continue
    const oldRolePerms = await prisma.rolePermission.findMany({ where: { permission_id: oldP.id } })
    for (const rp of oldRolePerms) {
      await prisma.rolePermission.upsert({
        where: {
          role_id_permission_id: {
            role_id: rp.role_id,
            permission_id: newP.id,
          },
        },
        update: {},
        create: {
          role_id: rp.role_id,
          permission_id: newP.id,
        },
      })
    }
    await prisma.rolePermission.deleteMany({ where: { permission_id: oldP.id } })
    try {
      await prisma.permission.delete({ where: { id: oldP.id } })
      console.log(`  Permiso migrado: ${oldCode} → ${newCode}`)
    } catch (err) {
      console.log(`  No se pudo eliminar permiso legacy ${oldCode}: ${err.message}`)
    }
  }

  // ========================================
  // 5. ASIGNACIÓN DE PERMISOS A ROLES
  // ========================================
  console.log('Asignando permisos a roles...')

  // Obtener todos los permisos
  const allPermissions = await prisma.permission.findMany()
  const permissionsMap = new Map(allPermissions.map(p => [p.code, p.id]))

  // Obtener roles
  const adminRole = await prisma.role.findFirst({ where: { name: { equals: 'admin', mode: 'insensitive' } } })

  if (adminRole) {
    // Admin tiene TODOS los permisos
    const adminPermissions = allPermissions.map(p => ({
      role_id: adminRole.id,
      permission_id: p.id,
    }))
    
    await prisma.rolePermission.createMany({
      data: adminPermissions,
      skipDuplicates: true,
    })
    console.log(`  ${adminPermissions.length} permisos asignados al rol 'admin'`)
  }

  // ========================================
  // 6. MIGRACIÓN DE PERMISOS LEGACY
  // ========================================
  // Si existe products.adjust_stock, migrarlo a products.register_incoming
  console.log('Migrando permisos legacy...')
  const oldAdjustStock = await prisma.permission.findUnique({ where: { code: 'products.adjust_stock' } })
  const newRegisterIncoming = await prisma.permission.findUnique({ where: { code: 'products.register_incoming' } })

  if (oldAdjustStock && newRegisterIncoming) {
    // Actualizar role_permissions que usan el permiso antiguo
    const oldRolePerms = await prisma.rolePermission.findMany({
      where: { permission_id: oldAdjustStock.id },
    })

    for (const rp of oldRolePerms) {
      await prisma.rolePermission.upsert({
        where: {
          role_id_permission_id: {
            role_id: rp.role_id,
            permission_id: newRegisterIncoming.id,
          },
        },
        update: {},
        create: {
          role_id: rp.role_id,
          permission_id: newRegisterIncoming.id,
        },
      })
    }

    // Eliminar el permiso antiguo
    await prisma.rolePermission.deleteMany({
      where: { permission_id: oldAdjustStock.id },
    })
    await prisma.permission.delete({
      where: { id: oldAdjustStock.id },
    })
    console.log('  Permiso legacy migrado: products.adjust_stock -> products.register_incoming')
  }

  // ========================================
  // 7. CONFIGURACIÓN DEL SISTEMA (valores por defecto)
  // ========================================
  console.log('Configurando valores por defecto del sistema...')
  const defaultDenominations = JSON.stringify([
    { denomination: 200, type: 'Billete' }, { denomination: 100, type: 'Billete' },
    { denomination: 50, type: 'Billete' }, { denomination: 20, type: 'Billete' },
    { denomination: 10, type: 'Billete' }, { denomination: 5, type: 'Billete' }, { denomination: 1, type: 'Billete' },
    { denomination: 0.5, type: 'Moneda' }, { denomination: 0.25, type: 'Moneda' },
    { denomination: 0.1, type: 'Moneda' }, { denomination: 0.05, type: 'Moneda' }
  ])
  const defaultSettings = [
    { key: 'currency_code', value: 'GTQ', type: 'string', description: 'Código de moneda principal' },
    { key: 'currency_name', value: 'Quetzal', type: 'string', description: 'Nombre de la moneda' },
    { key: 'timezone', value: 'America/Guatemala', type: 'string', description: 'Zona horaria del sistema' },
    { key: 'company_name', value: 'Mi Empresa', type: 'string', description: 'Nombre o razón social de la empresa' },
    { key: 'company_logo_url', value: '', type: 'string', description: 'URL pública del logo del negocio (Supabase bucket logo)' },
    { key: 'cash_closure_denominations', value: defaultDenominations, type: 'json', description: 'Denominaciones para conteo de cierre de caja' },
    // Datos fiscales (preparación FEL)
    { key: 'company_nit', value: '', type: 'string', description: 'NIT del emisor' },
    { key: 'company_address', value: '', type: 'string', description: 'Dirección fiscal' },
    { key: 'company_municipality', value: '', type: 'string', description: 'Municipio' },
    { key: 'company_department', value: '', type: 'string', description: 'Departamento' },
    { key: 'company_postal_code', value: '', type: 'string', description: 'Código postal' },
    { key: 'establishment_code', value: '', type: 'string', description: 'Código de establecimiento' },
    { key: 'vat_affiliation', value: '', type: 'string', description: 'Afiliación IVA (régimen general, pequeño contribuyente, etc.)' },
    { key: 'date_format', value: 'dd/MM/yyyy', type: 'string', description: 'Formato de fecha por defecto (dd/MM/yyyy o MM/dd/yyyy)' },
    { key: 'locale', value: 'es-GT', type: 'string', description: 'Locale para números y fechas (ej. es-GT)' },
    { key: 'cash_closure_max_diff_pct', value: '5', type: 'string', description: 'Diferencia máxima permitida en cierre de caja (%) antes de advertencia' },
    { key: 'quote_validity_days', value: '30', type: 'string', description: 'Días de vigencia por defecto para cotizaciones (Q-)' },
    { key: 'order_validity_days', value: '7', type: 'string', description: 'Días de vigencia / reserva por defecto para pedidos (P-)' },
    { key: 'quote_soft_hold_hours', value: '48', type: 'string', description: 'Horas de apartado blando al enviar cotización (Q-)' },
  ]
  for (const s of defaultSettings) {
    await prisma.systemSetting.upsert({
      where: { company_id_key: { company_id: DEFAULT_COMPANY_ID, key: s.key } },
      update: {},
      create: { ...s, company_id: DEFAULT_COMPANY_ID }
    })
  }
  console.log('  Valores por defecto de configuración listos')

  // ========================================
  // 7b. Caja registradora por defecto (apertura de caja / multi-caja futuro)
  // ========================================
  await prisma.cashRegister.upsert({
    where: { id: 'c0ffee00-0000-4000-8000-000000000001' },
    update: { name: 'Caja principal', code: 'PRINCIPAL', is_default: true, active: true },
    create: {
      id: 'c0ffee00-0000-4000-8000-000000000001',
      branch_id: DEFAULT_BRANCH_ID,
      name: 'Caja principal',
      code: 'PRINCIPAL',
      is_default: true,
      active: true
    }
  })
  console.log('  Caja principal (cash_registers) lista')

  // ========================================
  // 7c. CONTABILIDAD - catálogo de cuentas GT
  // ========================================
  console.log('Creando catálogo de cuentas...')
  await seedChartOfAccounts(prisma, DEFAULT_COMPANY_ID)
  console.log('  Catálogo de cuentas y mapeo por defecto listos')

  // ========================================
  // 8. USUARIO ADMIN POR DEFECTO (OPCIONAL)
  // ========================================
  console.log('Verificando usuario admin...')
  if (adminRole) {
    const existingAdmin = await prisma.user.findUnique({
      where: { email: 'admin@ejemplo.com' },
    })

    const admin = existingAdmin ?? await prisma.user.create({
      data: {
        name: 'Admin',
        email: 'admin@ejemplo.com',
        password: '7c4a8d09ca3762af61e59520943dc26494f8941b', // DEBE SER REEMPLAZADO CON HASH REAL
        role_id: adminRole.id,
        default_branch_id: DEFAULT_BRANCH_ID,
      },
    })
    console.log(existingAdmin
      ? '  Usuario admin ya existe'
      : '  Usuario admin creado con password temporal. DEBE CAMBIARSE.')

    // Sin membresía no puede entrar: el middleware exige al menos una sucursal.
    await prisma.userCompany.upsert({
      where: { user_id_company_id: { user_id: admin.id, company_id: DEFAULT_COMPANY_ID } },
      update: {},
      create: { user_id: admin.id, company_id: DEFAULT_COMPANY_ID },
    })
    await prisma.userBranch.upsert({
      where: { user_id_branch_id: { user_id: admin.id, branch_id: DEFAULT_BRANCH_ID } },
      update: {},
      create: { user_id: admin.id, branch_id: DEFAULT_BRANCH_ID },
    })
    if (!admin.default_branch_id) {
      await prisma.user.update({ where: { id: admin.id }, data: { default_branch_id: DEFAULT_BRANCH_ID } })
    }
    console.log('  Admin asignado a la empresa y sucursal principal')
  }

  console.log('')
  console.log('Seed completado exitosamente!')
  console.log('')
  console.log('Resumen:')
  console.log(`  - ${roles.length} roles`)
  console.log(`  - ${permissions.length} permisos`)
  console.log(`  - ${allPermissions.length} permisos totales en BD`)
}

main()
  .catch(e => {
    console.error('Error en seed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
