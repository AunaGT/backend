const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { getDevelopmentClient, createDevelopmentFixture, expectDatabaseRejection } = require('./helpers/paymentMethodsDevelopmentFixture.cjs')
const { resolvePaymentMethod, lockPaymentMethods } = require('../src/services/paymentMethods/access')
const { seedCompanyPaymentMethods } = require('../src/services/paymentMethods/seed')
const { updateCompanyPaymentMethod } = require('../src/services/paymentMethods/management')
const { resolveEngagementSettlementMethod } = require('../src/services/paymentMethods/engagementSettlement')
function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
const TX = { timeout: 30000, maxWait: 15000 }
test('company payment methods on current development Supabase', {
  skip: process.env.AUNA_DEV_PAYMENT_METHOD_TESTS !== '1', timeout: 180000,
}, async t => {
  const db = getDevelopmentClient()
  let f
  try {
    f = await createDevelopmentFixture(db)
    const { A, B } = f
    const before = await db.paymentMethod.findMany({ where: { company_id: null }, select: { id: true, name: true, is_credit: true }, orderBy: { id: 'asc' } })
    const ownA = await f.ownMethod(A.id, 'QA Mostrador', 'CASH')
    const ownB = await f.ownMethod(B.id, 'QA Mostrador', 'CASH')
    await t.test('same private labels are isolated; foreign preferences and normalized duplicates fail', async () => {
      assert.notEqual(ownA.id, ownB.id)
      await assert.rejects(db.$transaction(tx => resolvePaymentMethod(tx, { companyId: A.id, methodId: ownB.id, purpose: 'RECEIPT' }), TX), { code: 'PM_NOT_FOUND' })
      await expectDatabaseRejection(db,tx=>tx.companyPaymentMethod.create({ data: { company_id: A.id, payment_method_id: ownB.id } }),e=>/Payment method belongs to another company/.test(e.message))
      await expectDatabaseRejection(db,async tx => {
        await tx.paymentMethod.create({ data: { name: ' qa MOSTRADOR ', company_id: A.id, settlement_kind: 'CASH', is_credit: false } })
      },e=>e.code==='P2002')
      assert.equal(await db.companyPaymentMethod.count({ where: { company_id: A.id, payment_method_id: ownB.id } }), 0)
    })
    await t.test('receipt resolution holds a shared lock until commit; disable is ordered after it', async () => {
      const acquired = deferred(), release = deferred()
      const operation = db.$transaction(async tx => {
        await resolvePaymentMethod(tx, { companyId: A.id, methodId: ownA.id, purpose: 'RECEIPT' })
        acquired.resolve()
        await release.promise
        return 'operation-committed'
      }, TX)
      // Observe failures immediately; no unresolved latch survives a failed operation.
      operation.catch(() => acquired.resolve())
      let disable
      try {
        await acquired.promise
        const key = `payment-methods:${A.id}`
        const probe = await db.$transaction(tx => tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended(${key},0)) AS acquired`, TX)
        assert.equal(probe[0].acquired, false)
        disable = updateCompanyPaymentMethod(db, A.id, ownA.id, { enabled: false })
        disable.catch(() => {})
        release.resolve()
        assert.equal(await operation, 'operation-committed')
        await disable
        await assert.rejects(db.$transaction(tx => resolvePaymentMethod(tx, { companyId: A.id, methodId: ownA.id, purpose: 'RECEIPT' }), TX), { code: 'PM_DISABLED' })
      } finally {
        release.resolve()
        await Promise.allSettled([operation, ...(disable ? [disable] : [])])
      }
    })
    await t.test('disabled-before-resolution and repeat seed preserve company preferences', async () => {
      await updateCompanyPaymentMethod(db, A.id, ownA.id, { position: 8 })
      const cash = before.find(m => m.name.toLowerCase() === 'efectivo')
      await updateCompanyPaymentMethod(db, A.id, cash.id, { enabled: false, position: 9 })
      await db.$transaction(tx => seedCompanyPaymentMethods(tx, A.id), TX)
      const row = await db.companyPaymentMethod.findUnique({ where: { company_id_payment_method_id: { company_id: A.id, payment_method_id: cash.id } } })
      assert.equal(row.enabled, false); assert.equal(row.position, 9)
      await assert.rejects(db.$transaction(tx => resolvePaymentMethod(tx, { companyId: A.id, methodId: ownA.id, purpose: 'RECEIPT' }), TX), { code: 'PM_DISABLED' })
      assert.equal((await db.$transaction(tx => resolvePaymentMethod(tx, { companyId: B.id, methodId: cash.id, purpose: 'RECEIPT' }), TX)).id, cash.id)
    })
    await t.test('two concurrent disables cannot remove both remaining effective means', async () => {
      // Controlled fixture-only preparation under the same company lock.
      await db.$transaction(async tx => {
        await lockPaymentMethods(tx, A.id, 'write')
        await tx.companyPaymentMethod.updateMany({ where: { company_id: A.id }, data: { enabled: false } })
        await tx.companyPaymentMethod.updateMany({ where: { company_id: A.id, payment_method: { base_code: { in: ['CARD','TRANSFER'] } } }, data: { enabled: true } })
      }, TX)
      const last = await db.companyPaymentMethod.findMany({ where: { company_id: A.id, enabled: true } })
      assert.equal(last.length, 2)
      const outcomes = await Promise.allSettled(last.map(r => updateCompanyPaymentMethod(db, A.id, r.payment_method_id, { enabled: false })))
      assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1)
      assert.equal(outcomes.find(r => r.status === 'rejected').reason.code, 'PM_LAST_EFFECTIVE')
      assert.equal(await db.companyPaymentMethod.count({ where: { company_id: A.id, enabled: true, payment_method: { is_credit: false } } }), 1)
    })
    await t.test('confirmed sale guard only permits covered linked Agenda receipts, not POS or partial/spoofed source', async () => {
      const status = await db.saleStatus.findFirst({ where: { name: 'Completada' } })
      assert.ok(status)
      const engagementId = randomUUID(); f.ids.engagements.push(engagementId)
      const e = await db.appointmentEngagement.create({ data: { id: engagementId, company_id: A.id, branch_id: A.branchId, customer_id: A.customerId, source: 'DIRECT', currency_code: 'GTQ', agreed_total: 100, commercial_snapshot: {}, created_by: A.userId } })
      for (const [i, methodId] of [ownA.id, before.find(m => m.name.toLowerCase() === 'tarjeta').id].entries()) {
        const id = randomUUID(), commitmentId = randomUUID(); f.ids.receipts.push(id); f.ids.commitments.push(commitmentId)
        await db.customerPayment.create({ data: { id, branch_id: A.branchId, customer_id: A.customerId, amount: 50, paid_at: new Date(), payment_method_id: methodId, registered_by: A.userId } })
        await db.paymentCommitment.create({ data: { id: commitmentId, company_id: A.id, branch_id: A.branchId, customer_id: A.customerId, engagement_id: e.id, payment_id: id, amount: 50 } })
      }
      const scope = { companyId: A.id, branchId: A.branchId }
      assert.equal(await db.$transaction(tx => resolveEngagementSettlementMethod(tx, scope, e, '0.00'), TX), null)
      const data = { branch_id: A.branchId, customer_contact_id: A.customerId, total: 100, adjusted_total: 100, items: 0, status_id: status.id, payment_method_id: null, created_by: A.userId }
      const guardReject = change => expectDatabaseRejection(db,tx=>tx.sale.create({data:{id:randomUUID(),...data,...change}}),e=>/Confirmed sales require a payment method or covered engagement receipts/.test(e.message))
      await guardReject({ settlement_source: 'LEGACY' })
      await guardReject({ settlement_source: 'ENGAGEMENT_RECEIPTS' })
      await guardReject({ settlement_source: 'ENGAGEMENT_RECEIPTS', origin_engagement_id: e.id, adjusted_total: 101 })
      await guardReject({ settlement_source: 'ENGAGEMENT_RECEIPTS', origin_engagement_id: e.id, customer_contact_id: B.customerId })
      const countBefore = {
        receipts: await db.customerPayment.count({ where: { id: { in: f.ids.receipts } } }),
        applications: await db.salePaymentEntry.count({ where: { customer_payment_id: { in: f.ids.receipts } } }),
        journals: await db.journalEntry.count({ where: { company_id: A.id } }),
      }
      const id = randomUUID(); f.ids.sales.push(id)
      await db.sale.create({ data: { id, ...data, settlement_source: 'ENGAGEMENT_RECEIPTS', origin_engagement_id: e.id } })
      await db.sale.update({ where: { id }, data: { payment_status: 'PAID' } })
      const rejectedByGuard=e=>/Confirmed sales require a payment method or covered engagement receipts/.test(e.message)
      await expectDatabaseRejection(db,tx=>tx.sale.update({ where: { id }, data: { settlement_source: 'LEGACY' } }),rejectedByGuard)
      await expectDatabaseRejection(db,tx=>tx.sale.update({ where: { id }, data: { adjusted_total: 101 } }),rejectedByGuard)
      assert.deepEqual({
        receipts: await db.customerPayment.count({ where: { id: { in: f.ids.receipts } } }),
        applications: await db.salePaymentEntry.count({ where: { customer_payment_id: { in: f.ids.receipts } } }),
        journals: await db.journalEntry.count({ where: { company_id: A.id } }),
      }, countBefore)
      await db.paymentCommitment.updateMany({ where: { id: { in: f.ids.commitments } }, data: { state: 'APPLIED' } })
      await db.sale.update({ where: { id }, data: { payment_status: 'PAID' } })
    })
    await t.test('real Agenda issuance applies mixed receipts once and retries without new money or postings',async()=>{
      const {seedChartOfAccounts}=require('../src/services/accounting/seedChartOfAccounts')
      const {seedCompanyModules}=require('../src/modules/platform/service')
      const {receiveEngagementPayment}=require('../src/modules/receivables/engagementPayments')
      const {issueEngagementSale}=require('../src/modules/appointments/engagementSales')
      const stockStatus=await db.stockStatus.findFirst({where:{name:'Disponible'}})
      assert.ok(stockStatus,'Requiere el estado básico Disponible')
      const productId=randomUUID(),engagementId=randomUUID()
      f.ids.products.push(productId);f.ids.engagements.push(engagementId)
      const e=await db.$transaction(async tx=>{
        await seedCompanyModules(tx,A.id)
        await tx.companyModule.updateMany({where:{company_id:A.id,module_code:{in:['appointments','sales','receivables','inventory','contacts','accounting']}},data:{status:'ACTIVE'}})
        await seedChartOfAccounts(tx,A.id)
        await tx.account.create({data:{company_id:A.id,code:'2999',name:'QA anticipos de clientes',type:'LIABILITY'}})
        const key={company_id_key:{company_id:A.id,key:'accounting.defaultAccounts'}}
        const defaults=await tx.systemSetting.findUnique({where:key})
        await tx.systemSetting.update({where:key,data:{value:JSON.stringify({...JSON.parse(defaults.value),customerAdvances:'2999'})}})
        await tx.systemSetting.create({data:{company_id:A.id,key:'inventory_services_enabled',value:'true',type:'boolean'}})
        const category=await tx.productCategory.create({data:{company_id:A.id,name:'QA servicios'}})
        f.ids.categories.push(category.id)
        await tx.product.create({data:{id:productId,company_id:A.id,name:'QA asesoría',category_id:category.id,status_id:stockStatus.id,price:100,cost:0,kind:'SERVICE',service_unit_label:'Sesión'}})
        return tx.appointmentEngagement.create({data:{id:engagementId,company_id:A.id,branch_id:A.branchId,customer_id:A.customerId,source:'DIRECT',currency_code:'GTQ',agreed_total:100,commercial_snapshot:{customerNit:'CF',isFinalConsumer:true},created_by:A.userId,
          lines:{create:{company_id:A.id,branch_id:A.branchId,product_id:productId,item_kind:'SERVICE',item_name:'QA asesoría',unit_label:'Sesión',qty:1,unit_price:100,line_total:100}}},include:{customer:true,lines:true}})
      },TX)
      const scope={companyId:A.id,branchId:A.branchId,branchIds:[A.branchId],userId:A.userId,isAdmin:true,permissions:[]}
      const bankMethods=await db.paymentMethod.findMany({where:{company_id:null,base_code:{in:['CARD','TRANSFER']}},orderBy:{id:'asc'}})
      for(const method of bankMethods){
        await updateCompanyPaymentMethod(db,A.id,method.id,{enabled:true})
        const receipt=await db.$transaction(tx=>receiveEngagementPayment(tx,scope,e,{amount:'50.00',currencyCode:'GTQ',paymentMethodId:method.id,paidAt:new Date().toISOString(),idempotencyKey:randomUUID(),reference:'QA banco'}),TX)
        f.ids.receipts.push(receipt.id)
      }
      const commitments=await db.paymentCommitment.findMany({where:{engagement_id:e.id}})
      f.ids.commitments.push(...commitments.map(c=>c.id))
      await updateCompanyPaymentMethod(db,A.id,bankMethods[0].id,{enabled:false})
      const receiptCount=await db.customerPayment.count({where:{id:{in:f.ids.receipts}}})
      const input={expectedVersion:e.version,idempotencyKey:randomUUID(),paymentCondition:'CASH'}
      const first=await issueEngagementSale(db,scope,e.id,input)
      assert.ok(first.saleId);f.ids.sales.push(first.saleId)
      const sale=await db.sale.findUnique({where:{id:first.saleId},include:{paymentEntries:true}})
      assert.equal(sale.payment_method_id,null)
      assert.equal(sale.settlement_source,'ENGAGEMENT_RECEIPTS');assert.equal(sale.payment_status,'PAID')
      assert.equal(sale.paymentEntries.length,2)
      assert.equal(sale.paymentEntries.reduce((sum,r)=>sum+Number(r.amount),0),100)
      assert.equal(await db.customerPayment.count({where:{id:{in:f.ids.receipts}}}),receiptCount)
      const journals=await db.journalEntry.findMany({where:{company_id:A.id},select:{id:true,source_type:true,source_id:true},orderBy:{id:'asc'}})
      assert.equal(journals.filter(j=>j.source_type==='SALE'&&j.source_id===sale.id).length,1)
      assert.equal(journals.filter(j=>j.source_type==='CUSTOMER_ADVANCE_APPLIED').length,2)
      const retry=await issueEngagementSale(db,scope,e.id,input)
      assert.equal(retry.saleId,first.saleId)
      assert.equal(await db.salePaymentEntry.count({where:{sale_id:sale.id}}),2)
      assert.equal(await db.customerPayment.count({where:{id:{in:f.ids.receipts}}}),receiptCount)
      assert.deepEqual(await db.journalEntry.findMany({where:{company_id:A.id},select:{id:true,source_type:true,source_id:true},orderBy:{id:'asc'}}),journals)
    })
    assert.deepEqual(await db.paymentMethod.findMany({ where: { company_id: null }, select: { id: true, name: true, is_credit: true }, orderBy: { id: 'asc' } }), before)
  } finally {
    try { if (f) await f.cleanup() }
    finally { await db.$disconnect() }
  }
})
