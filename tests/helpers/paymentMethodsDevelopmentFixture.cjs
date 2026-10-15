const { randomUUID, randomBytes } = require('node:crypto')
const { seedCompanyPaymentMethods } = require('../../src/services/paymentMethods/seed')
const { createCompanyPaymentMethod } = require('../../src/services/paymentMethods/management')
const MIGRATION = '202610150002_company_payment_methods'
async function expectDatabaseRejection(db,work,acceptError=()=>true) {
  const accepted=Object.assign(new Error('La base permitió una operación que debía rechazar'),{code:'PM_DEV_PROBE_ACCEPTED'})
  try {
    await db.$transaction(async tx=>{await work(tx);throw accepted},{timeout:30000,maxWait:15000})
  } catch(error) {
    if(error===accepted||!acceptError(error))throw error
    return error
  }
}

function getDevelopmentClient() {
  if (process.env.AUNA_DEV_PAYMENT_METHOD_TESTS !== '1') {
    throw Object.assign(new Error('Activa explícitamente AUNA_DEV_PAYMENT_METHOD_TESTS=1 para usar la Supabase de desarrollo'), { code: 'PM_DEV_OPT_IN_REQUIRED' })
  }
  require('../../src/config/loadEnv')
  return require('../../src/models/prisma').prismaTransaction
}
async function assertPaymentMethodsMigration(db) {
  const applied = await db.$queryRaw`SELECT migration_name FROM _prisma_migrations WHERE migration_name=${MIGRATION} AND finished_at IS NOT NULL AND rolled_back_at IS NULL`
  if (applied.length !== 1 || !db.companyPaymentMethod) {
    throw Object.assign(new Error('Primero resuelve el bloqueo de despliegue, aplica la migración y genera Prisma Client'), { code: 'PM_DEV_MIGRATION_REQUIRED' })
  }
}
async function createDevelopmentFixture(db) {
  await assertPaymentMethodsMigration(db)
  const companyIds = [randomUUID(), randomUUID()]
  const userId = randomUUID(), branchIds = [randomUUID(), randomUUID()], customerIds = [randomUUID(), randomUUID()]
  const ids = { companies: companyIds, branches: branchIds, customers: customerIds, users: [userId], methods: [], engagements: [], receipts: [], commitments: [], sales: [], products:[],categories:[] }
  const role = await db.role.findFirst({ where: { name: 'admin' }, select: { id: true } })
  if (!role) throw new Error('No existe el rol admin básico; no se ejecutará la semilla completa')
  // One setup transaction means setup failure leaves no orphan fixture rows.
  await db.$transaction(async tx => {
    await tx.user.create({ data: { id: userId, name: 'QA métodos de pago', email: `${userId}@payment-methods.invalid`, password: randomBytes(48).toString('hex'), role_id: role.id } })
    for (let i = 0; i < 2; i++) {
      await tx.company.create({ data: { id: companyIds[i], name: 'QA métodos de pago', code: `PMQA-${companyIds[i].replaceAll('-', '').slice(0,12)}` } })
      await seedCompanyPaymentMethods(tx, companyIds[i])
      await tx.branch.create({ data: { id: branchIds[i], company_id: companyIds[i], name: 'QA sucursal', code: `Q${i}` } })
      await tx.supplier.create({ data: { id: customerIds[i], company_id: companyIds[i], name: 'QA cliente', contact: 'QA', party_type: 'CUSTOMER' } })
    }
  }, { timeout: 30000, maxWait: 15000 })
  const companies = companyIds.map((id, i) => ({ id, branchId: branchIds[i], customerId: customerIds[i], userId }))
  return {
    ids, A: companies[0], B: companies[1],
    async ownMethod(companyId, name, settlement_kind = 'BANK') {
      const method = await createCompanyPaymentMethod(db, companyId, { name, settlement_kind })
      ids.methods.push(method.id)
      return method
    },
    async cleanup() {
      // Exact IDs only, in reverse FK order. Never delete shared basics or roles.
      await db.$transaction(async tx => {
        if (ids.engagements.length) await tx.appointmentEngagement.updateMany({ where: { id: { in: ids.engagements } }, data: { sale_id: null } })
        const journals=await tx.journalEntry.findMany({where:{company_id:{in:ids.companies}},select:{id:true}})
        await tx.journalEntry.deleteMany({where:{id:{in:journals.map(j=>j.id)}}})
        await tx.appointmentRequest.deleteMany({where:{company_id:{in:ids.companies},actor_id:userId}})
        await tx.appointmentEngagementHistory.deleteMany({where:{engagement_id:{in:ids.engagements},company_id:{in:ids.companies}}})
        await tx.paymentAllocationEvent.deleteMany({where:{engagement_id:{in:ids.engagements},company_id:{in:ids.companies}}})
        await tx.salePaymentEntry.deleteMany({where:{customer_payment_id:{in:ids.receipts}}})
        const sales=await tx.sale.findMany({where:{origin_engagement_id:{in:ids.engagements},branch_id:{in:ids.branches}},select:{id:true}})
        const saleIds=[...new Set([...ids.sales,...sales.map(s=>s.id)])]
        await tx.saleHistory.deleteMany({where:{sale_id:{in:saleIds},company_id:{in:ids.companies}}})
        await tx.saleItem.deleteMany({where:{sale_id:{in:saleIds}}})
        await tx.sale.deleteMany({ where: { id: { in: saleIds } } })
        await tx.paymentCommitment.deleteMany({ where: { id: { in: ids.commitments } } })
        await tx.customerPayment.deleteMany({ where: { id: { in: ids.receipts } } })
        await tx.appointmentEngagementLine.deleteMany({where:{engagement_id:{in:ids.engagements}}})
        await tx.appointmentEngagement.deleteMany({ where: { id: { in: ids.engagements } } })
        await tx.product.deleteMany({where:{id:{in:ids.products},company_id:{in:ids.companies}}})
        await tx.productCategory.deleteMany({where:{id:{in:ids.categories},company_id:{in:ids.companies}}})
        await tx.supplier.deleteMany({ where: { id: { in: ids.customers } } })
        await tx.branch.deleteMany({ where: { id: { in: ids.branches } } })
        await tx.companyPaymentMethod.deleteMany({ where: { company_id: { in: ids.companies } } })
        await tx.paymentMethod.deleteMany({ where: { id: { in: ids.methods }, company_id: { in: ids.companies } } })
        await tx.systemSetting.deleteMany({where:{company_id:{in:ids.companies}}})
        await tx.companyModule.deleteMany({where:{company_id:{in:ids.companies}}})
        await tx.account.deleteMany({where:{company_id:{in:ids.companies}}})
        await tx.accountingPeriod.deleteMany({where:{company_id:{in:ids.companies}}})
        await tx.company.deleteMany({ where: { id: { in: ids.companies } } })
        await tx.user.deleteMany({ where: { id: { in: ids.users } } })
      }, { timeout: 30000, maxWait: 15000 })
    },
  }
}
module.exports = { getDevelopmentClient, assertPaymentMethodsMigration, createDevelopmentFixture, expectDatabaseRejection }
