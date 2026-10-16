require('../src/config/loadEnv')
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{PrismaClient}=require('@prisma/client')
const {syncLotExpiryAlerts}=require('../src/services/lots')
test('existing Supabase applies distinct expiry windows without resolving another company alerts',async()=>{
  const db=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL||process.env.DATABASE_URL}}}),companies=[randomUUID(),randomUUID()],branches=[randomUUID(),randomUUID()],products=[randomUUID(),randomUUID()]
  const today=new Date(new Date().toISOString().slice(0,10)),day=offset=>new Date(+today+offset*86400000)
  const policy=(i,warningDays)=>db.systemSetting.upsert({where:{company_id_key:{company_id:companies[i],key:'inventory.expiry_alert_policy'}},create:{company_id:companies[i],key:'inventory.expiry_alert_policy',value:JSON.stringify({warningDays,highPriorityDays:7}),type:'json'},update:{value:JSON.stringify({warningDays,highPriorityDays:7})}})
  const sync=i=>syncLotExpiryAlerts(db,{force:true,companyId:companies[i]})
  try{
    const stockStatus=await db.stockStatus.findFirst();assert.ok(stockStatus,'Existing system stock statuses required')
    for(let i=0;i<2;i++){
      await db.company.create({data:{id:companies[i],name:'QA vencimientos identificados',code:`ex-${companies[i].slice(0,12)}`}})
      await db.branch.create({data:{id:branches[i],company_id:companies[i],name:'QA vencimientos',code:'QA'}})
      const category=await db.productCategory.create({data:{company_id:companies[i],name:'QA'}})
      const supplier=await db.supplier.create({data:{company_id:companies[i],name:'QA proveedor identificado',contact:'QA'}})
      await db.product.create({data:{id:products[i],company_id:companies[i],name:'QA vencimiento',category_id:category.id,supplier_id:supplier.id,price:10,cost:5,status_id:stockStatus.id,tracks_expiry:true}})
      await db.productLot.create({data:{product_id:products[i],branch_id:branches[i],lot_code:'QA',expiry_date:day(20),qty_received:1,qty_remaining:1}})
      await policy(i,i===0?10:40);assert.equal((await sync(i)).ok,true)
    }
    assert.equal(await db.alert.count({where:{branch_id:branches[0],resolved:0}}),0)
    assert.equal(await db.alert.count({where:{branch_id:branches[1],resolved:0}}),1)
    await policy(0,40);await sync(0);await policy(1,10);await sync(1)
    assert.equal(await db.alert.count({where:{branch_id:branches[0],resolved:0}}),1)
    assert.equal(await db.alert.count({where:{branch_id:branches[1],resolved:0}}),0)
    await db.productLot.updateMany({where:{product_id:products[0]},data:{expiry_date:day(-1)}});await sync(0)
    assert.equal((await db.alert.findFirst({where:{branch_id:branches[0],resolved:0},include:{priority:true}})).priority.name,'Crítica')
    await db.productLot.updateMany({where:{product_id:products[0]},data:{qty_remaining:0}});await sync(0)
    assert.equal(await db.alert.count({where:{branch_id:branches[0],resolved:0}}),0)
  }finally{
    await db.alert.deleteMany({where:{branch_id:{in:branches}}});await db.productLot.deleteMany({where:{product_id:{in:products}}});await db.product.deleteMany({where:{id:{in:products}}});await db.supplier.deleteMany({where:{company_id:{in:companies}}});await db.productCategory.deleteMany({where:{company_id:{in:companies}}});await db.branch.deleteMany({where:{id:{in:branches}}});await db.company.deleteMany({where:{id:{in:companies}}});await db.$disconnect()
  }
})
