const test = require('node:test')
const assert = require('node:assert/strict')
const units = require('../src/modules/inventory/units')
const scope = { companyId:'A',branchId:'B',actorId:'U',permissions:['products.view','products.edit','settings.manage'],isAdmin:false }
const product = {id:'P',company_id:'A',kind:'STANDARD',name:'Café',unit_metadata_version:2,base_unit_id:'kg',quantity_decimals:6,unit_revision:1,price:'2',deleted:false}
const kg = {id:'kg',company_id:'A',code:'KG',family:'MASS',name:'Kilogramo',label:'kg',factor:'1',quantity_decimals:6,active:true}
function database() {
  const state={product:{...product},units:[{...kg}],presentations:[],barcodes:[],history:false}
  const match=(row,where)=>Object.entries(where).every(([k,v])=>k==='OR'?v.some(w=>match(row,w)):typeof v==='object'&&v!==null?true:row[k]===v)
  const model=rows=>({findFirst:async({where})=>rows().find(r=>match(r,where))||null,findMany:async({where={}}={})=>rows().filter(r=>match(r,where)),count:async({where={}}={})=>rows().filter(r=>match(r,where)).length,
    create:async({data})=>{const row={id:`id-${rows().length}`,active:true,version:1,purchase_enabled:true,sale_enabled:true,...data};rows().push(row);return row},
    update:async({where,data})=>{const row=rows().find(r=>match(r,where));Object.assign(row,data);return row},
    updateMany:async({where,data})=>{const rowsFound=rows().filter(r=>match(r,where));for(const r of rowsFound)Object.assign(r,data);return{count:rowsFound.length}}})
  const db={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'})},$executeRaw:async()=>0,$queryRawUnsafe:async()=>[{review_required:false}],
    product:{...model(()=>[state.product]),findFirst:async({where})=>match(state.product,where)?state.product:null},
    measureUnit:model(()=>state.units),productPresentation:model(()=>state.presentations),productBarcode:model(()=>state.barcodes)}
  for(const name of ['saleItem','commercialDocumentLine','purchaseLog','incomingMerchandiseItem','stockMovement','productLot','stockTransferLine','inventoryCountLine','returnItem','returnReplacementItem','orderDeliveryLine','stockReservation','appointmentEngagementLine','appointmentSession'])db[name]={findFirst:async()=>state.history?{id:'history'}:null}
  db.productBomLine={findFirst:async()=>null};db.productStock={findFirst:async()=>null};db.productStockLocation={findFirst:async()=>null}
  let queue=Promise.resolve()
  db.$transaction=fn=>{const next=queue.then(()=>fn(db));queue=next.catch(()=>{});return next}
  return{db,state}
}
module.exports={database,scope,product,kg}

test('legacy product opt-in blocks recorded stock/history inconsistencies within its own company',async()=>{
  for(const action of [db=>units.configureProduct(db,scope,'P',{base_unit_id:'kg',unit_revision:1}),db=>units.savePresentation(db,scope,'P',{unit_revision:1,name:'Caja',label:'caja',factor:'24',quantity_decimals:0})]){
    const {db,state}=database();state.product.unit_metadata_version=1
    db.$queryRawUnsafe=async(sql,id,company)=>{assert.equal(id,'P');assert.equal(company,'A');return[{review_required:true}]}
    await assert.rejects(action(db),e=>e.status===409&&e.code==='UNIT_MIGRATION_REVIEW_REQUIRED')
    assert.equal(state.product.unit_metadata_version,1);assert.equal(state.product.unit_revision,1);assert.equal(state.presentations.length,0)
    await assert.rejects(units.configureProduct(db,{...scope,companyId:'OTHER'},'P',{base_unit_id:'kg',unit_revision:1}),e=>e.status===404)
  }
})

test('explicit configuration adopts legacy UNIT history without reinterpreting base or accepting a public marker',async()=>{
  const {db,state}=database();state.history=true
  Object.assign(state.product,{unit_metadata_version:1,base_unit_id:'u',quantity_decimals:0})
  state.units.push({...kg,id:'u',code:'UNIT',family:'COUNT',quantity_decimals:0})
  const saved=await units.configureProduct(db,scope,'P',{base_unit_id:'u',quantity_decimals:0,unit_revision:1})
  assert.equal(saved.unit_metadata_version,2);assert.equal(saved.unit_revision,2)
  await assert.rejects(units.configureProduct(db,scope,'P',{base_unit_id:'kg',unit_revision:2}),e=>e.status===409)
  await assert.rejects(units.prepareProductWrite(db,scope,state.product,{unit_metadata_version:1},{}),e=>e.status===400)
})
test('ordinary pricing edit of backfilled UNIT remains compatible and does not opt into v2',async()=>{
  const {db,state}=database();Object.assign(state.product,{unit_metadata_version:1,base_unit_id:'u',quantity_decimals:0})
  const data={price:'3'}
  await units.prepareProductWrite(db,scope,state.product,{price:'3'},data)
  assert.equal(data.price,'3');assert.equal(state.product.unit_metadata_version,1);assert.equal(state.product.unit_revision,1)
})
test('flag-off legacy barcode edits synchronize the registry without opting into advanced units',async()=>{
  const {db,state}=database();Object.assign(state.product,{unit_metadata_version:1,base_unit_id:'u',quantity_decimals:0,barcode:'OLD'})
  db.systemSetting.findUnique=async()=>({key:'inventory_units_enabled',value:'false'})
  state.barcodes.push({id:'old',company_id:'A',product_id:'P',presentation_id:null,code:'OLD',active:true})
  const data={barcode:' NEW '},finish=await units.prepareProductWrite(db,scope,state.product,{barcode:' NEW '},data)
  Object.assign(state.product,data);await finish(state.product)
  assert.equal(state.product.barcode,'NEW');assert.equal(state.product.unit_metadata_version,1)
  assert.equal(state.barcodes.find(r=>r.code==='OLD').active,false)
  assert.equal(state.barcodes.find(r=>r.code==='NEW').active,true)
})

test('catalog reads require product access but do not require settings management',async()=>{
  const {db}=database()
  assert.equal((await units.listUnits(db,{...scope,permissions:['products.view']}))[0].code,'KG')
  await assert.rejects(units.listUnits(db,{...scope,permissions:[]}),e=>e.status===403)
  await assert.rejects(units.saveUnit(db,{...scope,permissions:['products.view']},{name:'Libra'}),e=>e.status===403)
})
test('catalog and product configuration cannot use another company unit or product',async()=>{
  const {db}=database()
  await assert.rejects(units.configureProduct(db,{...scope,companyId:'X'},'P',{base_unit_id:'kg',unit_revision:1}),e=>e.status===404)
  await assert.rejects(units.configureProduct(db,scope,'P',{base_unit_id:'foreign',unit_revision:1}),e=>e.status===404)
  await assert.rejects(units.configureProduct(db,{...scope,branchId:null},'P',{base_unit_id:'kg',unit_revision:1}),e=>e.status===400)
})
test('archiving a used unit retains its identity and rejects changing its conversion',async()=>{
  const {db,state}=database()
  assert.equal((await units.saveUnit(db,scope,{active:false},'kg')).active,false)
  assert.equal(state.product.base_unit_id,'kg')
  await assert.rejects(units.saveUnit(db,scope,{factor:'2'},'kg'),e=>e.status===409)
  assert.equal(state.units[0].factor,'1')
})
test('any existing history forbids changing a product base or precision',async()=>{
  const {db,state}=database();state.history=true
  state.units.push({...kg,id:'g',code:'G',factor:'0.001'})
  for(const change of [{base_unit_id:'g'},{quantity_decimals:3}]){
    await assert.rejects(units.configureProduct(db,scope,'P',{...change,unit_revision:1}),e=>e.status===409)
    assert.equal(state.product.unit_revision,1)
  }
})
test('presentation conversion changes create a successor and move only own defaults',async()=>{
  const {db,state}=database()
  const first=await units.savePresentation(db,scope,'P',{unit_revision:1,name:'Saco',label:'saco',factor:'24',quantity_decimals:0,prices:{LIST:'40',WHOLESALE:'35'}})
  assert.equal(first.factor,'24');assert.equal(first.price,'40')
  assert.equal(state.product.price,'2')
  await units.configureProduct(db,scope,'P',{unit_revision:2,default_sale_presentation_id:first.id})
  const next=await units.savePresentation(db,scope,'P',{unit_revision:3,factor:'25'},first.id)
  assert.notEqual(next.id,first.id);assert.equal(next.version,2)
  assert.equal(first.active,false);assert.equal(first.successor_id,next.id);assert.equal(first.factor,'24')
  assert.equal(state.product.default_sale_presentation_id,next.id)
  await assert.rejects(units.savePresentation(db,scope,'P',{unit_revision:1,name:'Stale'},next.id),e=>e.status===409)
})
test('foreign and disabled defaults are rejected without changing the product',async()=>{
  const {db,state}=database()
  state.presentations.push({id:'foreign',company_id:'X',product_id:'other',active:true,sale_enabled:true})
  await assert.rejects(units.configureProduct(db,scope,'P',{unit_revision:1,default_sale_presentation_id:'foreign'}),e=>e.status===404)
  state.presentations.push({id:'disabled',company_id:'A',product_id:'P',active:true,sale_enabled:false})
  await assert.rejects(units.configureProduct(db,scope,'P',{unit_revision:1,default_sale_presentation_id:'disabled'}),e=>e.status===400)
})
test('measured-unit presentations must share the base family and derive factor on the server',async()=>{
  const {db,state}=database();state.units.push({...kg,id:'g',code:'G',factor:'0.001'},{...kg,id:'m',code:'M',family:'LENGTH'})
  const grams=await units.savePresentation(db,scope,'P',{unit_revision:1,name:'Gramo',label:'g',measure_unit_id:'g',quantity_decimals:0})
  assert.equal(grams.factor,'0.001')
  await assert.rejects(units.savePresentation(db,scope,'P',{unit_revision:2,name:'Metro',label:'m',measure_unit_id:'m',quantity_decimals:0}),e=>e.status===400)
})
test('standard units seed idempotently per company without overwriting local archive state',async()=>{
  const rows=[];const db={measureUnit:{createMany:async({data,skipDuplicates})=>{assert.equal(skipDuplicates,true);for(const r of data)if(!rows.some(x=>x.code===r.code&&x.company_id===r.company_id))rows.push({...r})}}}
  await units.seedStandardUnits(db,'A');const count=rows.length;assert.ok(count>=6)
  rows.find(r=>r.code==='KG').active=false
  await units.seedStandardUnits(db,'A');assert.equal(rows.length,count);assert.equal(rows.find(r=>r.code==='KG').active,false)
  await units.seedStandardUnits(db,'X');assert.equal(rows.length,count*2)
  assert.equal(rows.find(r=>r.code==='LB').factor,'0.45359237')
})
test('units remain default off after deployment while explicit activation and in-use disable guards work',async()=>{
  const defaults=require('../src/services/companySettings').defaultCompanySettings()
  assert.equal(defaults.find(([key])=>key==='inventory_units_enabled')?.[1],'false')
  const {db,state}=database()
  await units.assertUnitsSettingChange(db,'A','true')
  assert.equal(await units.unitsEnabled({systemSetting:{findUnique:async()=>null}},'new-company'),false)
  await assert.rejects(units.assertUnitsSettingChange(db,'A','false'),e=>e.status===409)
  state.product.base_unit_id=null
  await units.assertUnitsSettingChange({...db,systemSetting:{findUnique:async()=>null}},'A','false')
})
test('ordinary product writers reject forged conversion fields even when the feature is off',async()=>{
  for(const field of ['factor','unit_snapshot','base_qty','base_unit','presentations','barcodes'])await assert.rejects(units.prepareProductWrite({},scope,null,{[field]:field},{}),e=>e.status===400)
  await assert.rejects(units.prepareProductWrite({},scope,null,{base_unit_id:'kg'},{}),e=>e.status===403)
  const finish=await units.prepareProductWrite({},scope,null,{name:'Legacy'},{name:'Legacy'})
  assert.deepEqual(await finish({id:'new'}),{id:'new'})
})
test('existing product writer uses the same immutable base rule before persisting a scalar edit',async()=>{
  const {db,state}=database();state.history=true
  await assert.rejects(units.prepareProductWrite(db,scope,state.product,{quantity_decimals:3,unit_revision:1},{}),e=>e.status===409)
})
test('settings API permits explicit company opt-in after deployment without enabling another company',async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  const model=require.resolve('../src/models/prisma'),target=require.resolve('../src/modules/config/controller')
  const rows=[{company_id:'other',key:'inventory_units_enabled',value:'false',type:'string',revision:1}]
  const db={$transaction:async run=>run(db),$executeRaw:async()=>0,$queryRaw:async()=>[],systemSetting:{
    create:async({data})=>{const row={...data,revision:1};rows.push(row);return row},
    findMany:async({where})=>rows.filter(row=>row.company_id===where.company_id&&(!where.key||where.key.in.includes(row.key))),
  }}
  await withMocks({[model]:{prisma:db,prismaTransaction:db}},target,async controller=>{
    const response=jsonResponse()
    await controller.update({companyId:'A',user:{sub:'U',permissions:['settings.manage']},body:{settings:{inventory_units_enabled:true},expectedRevisions:{inventory_units_enabled:0}}},response,e=>{throw e})
    assert.equal(response.statusCode,200)
    assert.equal(rows.find(row=>row.company_id==='A').value,'true')
    assert.equal(rows.find(row=>row.company_id==='other').value,'false')
  })
})
test('existing create and update routes reject forged server units before any database access',async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{},prismaTransaction:{}}},require.resolve('../src/modules/inventory/products.controller'),async controller=>{
    for(const method of ['create','update'])await assert.rejects(controller[method]({companyId:'A',branchId:'B',body:{factor:'24'},params:{id:'P'}},jsonResponse(),e=>{throw e}),e=>e.status===400)
  })
})
test('import rejects forged unit definitions rather than bypassing product configuration',async()=>{
  const {withMocks}=require('./helpers/reportHarness.cjs')
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{product:{create:async()=>assert.fail('No unchecked import write')}}}},require.resolve('../src/services/bulkImport'),async service=>{
    const result=await service.bulkCreateProducts([{rowIndex:2,data:{factor:'24'}}],{companyId:'A',branchId:'B'})
    assert.equal(result.skipped,1);assert.match(result.errors[0].error,/servidor/i)
  })
})
test('a configured product can archive a presentation whose measure unit is already archived',async()=>{
  const {db,state}=database();state.units.push({...kg,id:'g',code:'G',factor:'0.001'})
  const p=await units.savePresentation(db,scope,'P',{unit_revision:1,name:'Gramo',label:'g',measure_unit_id:'g',quantity_decimals:0})
  state.units.find(r=>r.id==='g').active=false
  assert.equal((await units.savePresentation(db,scope,'P',{unit_revision:2,active:false},p.id)).active,false)
})
test('concurrent presentation edits cannot both claim the same product revision',async()=>{
  const {db,state}=database()
  const results=await Promise.allSettled(['Caja','Saco'].map(name=>db.$transaction(tx=>units.savePresentation(tx,scope,'P',{unit_revision:1,name,label:name,factor:'24',quantity_decimals:0}))))
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(results.find(r=>r.status==='rejected').reason.status,409)
  assert.equal(state.presentations.length,1);assert.equal(state.product.unit_revision,2)
})
test('physical writers cannot introduce fractional precision without a configured base unit',async()=>{
  const physical={id:'P',kind:'STANDARD',quantity_decimals:0,company_id:'A'}
  await assert.rejects(units.prepareProductWrite({},scope,physical,{quantity_decimals:3},{}),e=>e.status===400)
})
test('archiving a base unit still permits updating its existing product defaults',async()=>{
  const {db,state}=database();state.units[0].active=false
  const configured=await units.configureProduct(db,scope,'P',{unit_revision:1,default_sale_presentation_id:null})
  assert.equal(configured.base_unit_id,'kg');assert.equal(configured.unit_revision,2)
})
test('a configured service can edit six-decimal base prices while retaining its quantity precision',async()=>{
  const {db,state}=database();Object.assign(state.product,{kind:'SERVICE',quantity_decimals:2,service_unit_label:'Hora'})
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/inventory/products.controller'),async controller=>{
    const response=jsonResponse()
    await controller.update({companyId:'A',branchId:'B',params:{id:'P'},user:{sub:'U',permissions:['products.edit']},body:{price:'1.123456',unit_revision:1}},response,e=>{throw e})
    assert.equal(response.body.price,'1.123456');assert.equal(response.body.quantity_decimals,2)
  })
})
test('changing box content retires its printed code and a new code resolves only the new factor',async()=>{
  const {db,state}=database()
  const first=await units.savePresentation(db,scope,'P',{unit_revision:1,name:'Caja',label:'caja',factor:'24',quantity_decimals:0,barcode:'BOX24'})
  assert.equal((await units.resolveBarcode(db,scope,'BOX24')).presentation_id,first.id)
  const next=await units.savePresentation(db,scope,'P',{unit_revision:2,factor:'25',barcode:'BOX25'},first.id)
  await assert.rejects(units.resolveBarcode(db,scope,'BOX24'),e=>e.status===404)
  const found=await units.resolveBarcode(db,scope,'BOX25')
  const line=await units.resolveUnitLine(db,{...scope,permissions:['sales.create']},state.product,{qty:'1',presentation_id:found.presentation_id,unit_revision:found.unit_revision})
  assert.equal(line.base_qty,'25');assert.equal(line.unit_snapshot.factor,'25')
  assert.equal(state.barcodes.find(b=>b.code==='BOX24').presentation_id,first.id)
  await assert.rejects(units.savePresentation(db,scope,'P',{unit_revision:3,factor:'26',barcode:'BOX25'},next.id),e=>e.status===409&&e.code==='BARCODE_CONFLICT')
})
test('omitted code on changed content is retired while a same-content name/price successor may keep it',async()=>{
  const {db,state}=database()
  const first=await units.savePresentation(db,scope,'P',{unit_revision:1,name:'Caja',label:'caja',factor:'24',quantity_decimals:0,barcode:'BOX24'})
  const renamed=await units.savePresentation(db,scope,'P',{unit_revision:2,name:'Caja estándar',prices:{LIST:'40'}},first.id)
  assert.equal((await units.resolveBarcode(db,scope,'BOX24')).presentation_id,renamed.id)
  const changed=await units.savePresentation(db,scope,'P',{unit_revision:3,factor:'25'},renamed.id)
  await assert.rejects(units.resolveBarcode(db,scope,'BOX24'),e=>e.status===404)
  assert.equal(state.barcodes.find(b=>b.code==='BOX24').presentation_id,renamed.id)
  assert.equal(changed.factor,'25')
})
test('ordinary product PUT invalidates a preview when any effective base tariff changes',async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  for(const change of [{price:'3'},{price_wholesale:'1.123456'},{price_promotion:'1.5'},{promotion_valid_until:'2030-01-01T00:00:00.000Z'}]){
    const {db,state}=database();Object.assign(state.product,{kind:'SERVICE',quantity_decimals:2,service_unit_label:'Hora'})
    const original=structuredClone(state.product)
    const sales={...scope,permissions:['sales.create']}
    const preview=await units.resolveUnitLine(db,sales,original,{qty:'1',unit_revision:1})
    await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/inventory/products.controller'),async controller=>{
      const req={companyId:'A',branchId:'B',params:{id:'P'},user:{sub:'U',permissions:['products.edit']},body:{...change,unit_revision:1}}
      const response=jsonResponse();await controller.update(req,response,e=>{throw e})
      assert.equal(response.body.unit_revision,2)
      await assert.rejects(units.resolveUnitLine(db,sales,original,{qty:'1',unit_revision:preview.unit_revision}),e=>e.status===409&&e.code==='UNIT_REVISION_CONFLICT')
      await assert.rejects(controller.update({...req,body:{price:'4',unit_revision:1}},jsonResponse(),e=>{throw e}),e=>e.status===409)
      assert.notEqual(state.product.price,'4')
    })
  }
})
test('disable committing before the company lock prevents advanced mutation after a stale enable read',async()=>{
  const {writeSettings}=require('../src/services/settingsRevision')
  for(const mutate of [
    db=>units.configureProduct(db,scope,'P',{unit_revision:1,base_unit_id:'kg',quantity_decimals:6}),
    db=>units.saveUnit(db,scope,{name:'Nuevo nombre'},'kg'),
    db=>units.savePresentation(db,scope,'P',{unit_revision:1,name:'Caja',label:'caja',factor:'24',quantity_decimals:0}),
    (db,state)=>units.prepareProductWrite(db,scope,null,{base_unit_id:'kg'},{}),
  ]){
    const {db,state}=database();state.product.base_unit_id=null;state.product.unit_metadata_version=1;state.product.quantity_decimals=0
    let enabled=true,disableCommitted=false,disableLock=false
    db.systemSetting={findUnique:async()=>({key:'inventory_units_enabled',value:enabled?'true':'false'})}
    const originalFind=db.product.findFirst
    db.product.findFirst=async args=>args.where.base_unit_id?.not===null?(state.product.base_unit_id?state.product:null):originalFind(args)
    for(const model of ['sale','commercialDocument','incomingMerchandise','return'])db[model]={findFirst:async()=>null}
    const disabling={...db,$executeRaw:async()=>{disableLock=true},systemSetting:{...db.systemSetting,
      updateMany:async()=>{assert.equal(disableLock,true);enabled=false;return{count:1}},findMany:async()=>[]}}
    db.$executeRaw=async sql=>{
      if(!disableCommitted&&sql.join('').includes('pg_advisory_xact_lock')){
        await writeSettings(disabling,{companyId:'A',changes:{inventory_units_enabled:{value:'false',type:'string'}},expectedRevisions:{inventory_units_enabled:1}})
        disableCommitted=true
      }
    }
    await assert.rejects(mutate(db,state),e=>e.status===403)
    assert.equal(disableCommitted,true);assert.equal(state.product.base_unit_id,null);assert.equal(state.product.unit_revision,1)
    assert.equal(state.units[0].name,'Kilogramo');assert.equal(state.presentations.length,0)
  }
})
test('settings writer holds the company lock even when disabling an already-off flag',async()=>{
  const {writeSettings}=require('../src/services/settingsRevision');let held=false,stored='false'
  const db={$executeRaw:async()=>{held=true},systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:stored}),findMany:async()=>[],updateMany:async({data})=>{assert.equal(held,true);stored=data.value;return{count:1}}}}
  await writeSettings(db,{companyId:'A',changes:{inventory_units_enabled:{value:'false',type:'string'}},expectedRevisions:{inventory_units_enabled:1}})
  assert.equal(stored,'false')
})
test('equivalent base prices do not invalidate a preview but missing revisions cannot change a price',async()=>{
  const {db,state}=database(),{withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  Object.assign(state.product,{kind:'SERVICE',quantity_decimals:2,service_unit_label:'Hora'})
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/inventory/products.controller'),async controller=>{
    const req={companyId:'A',branchId:'B',params:{id:'P'},user:{sub:'U',permissions:['products.edit']}}
    await controller.update({...req,body:{price:'2.000000'}},jsonResponse(),e=>{throw e})
    assert.equal(state.product.unit_revision,1)
    await assert.rejects(controller.update({...req,body:{price:'3'}},jsonResponse(),e=>{throw e}),e=>e.status===409)
    assert.equal(state.product.price,'2');assert.equal(state.product.unit_revision,1)
  })
})
test('persisted tiny Decimal factors keep their barcode for equal-content successors and retire it only on a real change',async()=>{
  const {Prisma}=require('@prisma/client')
  for(const barcode of [undefined,'TINY']){
    const {db,state}=database()
    const first=await units.savePresentation(db,scope,'P',{unit_revision:1,name:'Medida',label:'medida',factor:'0.0000001',quantity_decimals:0,barcode:'TINY'})
    first.factor=new Prisma.Decimal('0.0000001')
    assert.equal(first.factor.toString(),'1e-7')
    const input={unit_revision:2,name:'Medida renombrada',prices:{LIST:'1.25'},factor:'0.0000001',...(barcode===undefined?{}:{barcode})}
    const same=await units.savePresentation(db,scope,'P',input,first.id)
    assert.equal((await units.resolveBarcode(db,scope,'TINY')).presentation_id,same.id)
    assert.equal(state.barcodes.find(b=>b.code==='TINY').active,true)
    same.factor=new Prisma.Decimal('0.0000001')
    const changed=await units.savePresentation(db,scope,'P',{unit_revision:3,factor:'0.0000002'},same.id)
    assert.equal(changed.factor,'0.0000002')
    await assert.rejects(units.resolveBarcode(db,scope,'TINY'),e=>e.status===404)
    assert.equal(state.barcodes.find(b=>b.code==='TINY').presentation_id,same.id)
    assert.equal(state.barcodes.find(b=>b.code==='TINY').active,false)
  }
})
