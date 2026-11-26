/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

// Acepta el `.env` estándar y el archivo local heredado llamado `env`.
require('../src/config/loadEnv')
const { PrismaClient } = require('@prisma/client')
const { ensureSystemAdmin } = require('../src/modules/users/roles/seed')
const { seedChartOfAccounts } = require('../src/services/accounting/seedChartOfAccounts')
const { seedCompanyModules } = require('../src/modules/platform/service')
const { ensurePaymentMethodBasics } = require('../src/services/paymentMethods/basics')
const { seedCompanyPaymentMethods } = require('../src/services/paymentMethods/seed')
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
  await seedCompanyModules(prisma, company.id)
  console.log('  Empresa y sucursal principal listas')

  // ========================================
  // 1. ROLES
  // ========================================
  console.log('Creando roles...')
  const roles = ['admin']
  await ensureSystemAdmin(prisma)
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
  const alertTypes = ['Stock Bajo', 'Sin Stock', 'Vencimiento', 'Precio']
  const alertPriorities = ['Baja', 'Media', 'Alta', 'Crítica']
  const returnStatuses = ['Pendiente', 'Aprobada', 'Rechazada', 'Completada']

  await prisma.status.createMany({ data: statuses.map(name => ({ name })), skipDuplicates: true })
  await prisma.stockStatus.createMany({ data: stockStatuses.map(name => ({ name })), skipDuplicates: true })
  await prisma.$transaction(async tx => {
    await ensurePaymentMethodBasics(tx)
    const companies=await tx.company.findMany({select:{id:true}})
    for(const company of companies) await seedCompanyPaymentMethods(tx,company.id)
  },{timeout:30000,maxWait:15000})
  await prisma.saleStatus.createMany({ data: saleStatuses.map(name => ({ name })), skipDuplicates: true })
  await prisma.alertType.createMany({ data: alertTypes.map(name => ({ name })), skipDuplicates: true })
  await prisma.alertPriority.createMany({ data: alertPriorities.map(name => ({ name })), skipDuplicates: true })
  await prisma.returnStatus.createMany({ data: returnStatuses.map(name => ({ name })), skipDuplicates: true })
  console.log('Estados y status creados')

  // ========================================
  // 4. PERMISOS - SISTEMA RBAC
  // ========================================
  console.log('Creando permisos del sistema...')
  
  const { permissions, registerPermissions } = require('../src/config/permissionCatalog')

  // Crear todos los permisos (idempotente)
  await registerPermissions(prisma)
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
  const adminRole = await prisma.role.findUnique({ where: { system_key: 'ADMIN' } })

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
    { key: 'inventory_units_enabled', value: 'false', type: 'string', description: 'Unidades y presentaciones de inventario' },
    { key: 'currency_code', value: 'GTQ', type: 'string', description: 'Código de moneda principal' },
    { key: 'currency_name', value: 'Quetzal', type: 'string', description: 'Nombre de la moneda' },
    { key: 'timezone', value: 'America/Guatemala', type: 'string', description: 'Zona horaria del sistema' },
    { key: 'company_name', value: 'Mi Empresa', type: 'string', description: 'Nombre o razón social de la empresa' },
    { key: 'company_logo_url', value: '', type: 'string', description: 'URL pública del logo del negocio (Supabase bucket logo)' },
    { key: 'cash_closure_denominations', value: defaultDenominations, type: 'json', description: 'Denominaciones para conteo de cierre de caja' },
    // Datos fiscales (preparación FEL)
    { key: 'company_nit', value: '', type: 'string', description: 'NIT del emisor' },
    { key: 'fel_enabled', value: 'false', type: 'string', description: 'El negocio emitirá facturas electrónicas mediante un certificador' },
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
  const {seedStandardUnits}=require('../src/modules/inventory/units')
  if(prisma.measureUnit)for(const company of await prisma.company.findMany({select:{id:true}}))await seedStandardUnits(prisma,company.id)

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
