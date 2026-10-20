const test=require('node:test'),assert=require('node:assert/strict')
const units=require('../src/modules/inventory/units')
const {seedCompanySettings}=require('../src/services/companySettings')

test('narrow catalog seeds every approved physical and independent business definition idempotently',async()=>{
 const rows=[],db={measureUnit:{createMany:async({data})=>{for(const row of data)if(!rows.some(r=>r.company_id===row.company_id&&r.code===row.code))rows.push({...row})}}}
 await units.seedStandardUnits(db,'A')
 const expected={UNIT:['COUNT','1'],DOCENA:['COUNT','12'],KG:['MASS','1'],G:['MASS','0.001'],LB:['MASS','0.45359237'],L:['VOLUME','1'],ML:['VOLUME','0.001'],M:['LENGTH','1'],CM:['LENGTH','0.01'],MM:['LENGTH','0.001'],M2:['AREA','1'],CM2:['AREA','0.0001'],MIN:['TIME','1'],H:['TIME','60'],SESSION:['SESSION','1'],WORK:['WORK','1'],VISIT:['VISIT','1'],EVENT:['EVENT','1']}
 assert.equal(rows.length,18)
 for(const [code,[family,factor]]of Object.entries(expected)){const row=rows.find(r=>r.code===code);assert.ok(row,code);assert.equal(row.family,family,code);assert.equal(row.factor,factor,code)}
 rows.find(r=>r.code==='KG').active=false
 await units.seedStandardUnits(db,'A');assert.equal(rows.length,18);assert.equal(rows.find(r=>r.code==='KG').active,false)
 await units.seedStandardUnits(db,'B');assert.equal(rows.length,36)
})
test('new-company provisioning seeds available catalog with advanced feature still disabled',async()=>{
 const settings=[],catalog=[],db={systemSetting:{createMany:async({data})=>settings.push(...data)},measureUnit:{createMany:async({data})=>catalog.push(...data)}}
 await seedCompanySettings(db,'A',{name:'Synthetic'})
 assert.equal(settings.find(s=>s.key==='inventory_units_enabled').value,'false')
 assert.equal(catalog.length,18)
 assert.ok(catalog.every(r=>r.company_id==='A'))
})
test('backfilled factor-one goods keep legacy integer contract while advanced and incomplete metadata fail closed',async()=>{
 const scope={companyId:'A',branchId:'B',permissions:['sales.create'],actorId:'U'}
 const product={id:'P',company_id:'A',kind:'STANDARD',name:'Legacy',base_unit_id:'UNIT-A',quantity_decimals:0,unit_metadata_version:1,unit_revision:1,price:'7',available_for_sale:true}
 const db={$executeRaw:async()=>0,product:{findFirst:async()=>product}}
 const line=await units.resolveUnitLine(db,scope,product,{qty:2})
 assert.equal(line.base_qty,'2');assert.equal(line.unit_metadata_version,1);assert.equal(line.unit_price,'7')
 await assert.rejects(units.resolveUnitLine(db,scope,product,{qty:'0.5'}),e=>e.status===400)
 await assert.rejects(units.resolveUnitLine(db,scope,product,{qty:1,presentation_id:'BOX'}),e=>e.status===409)
 product.unit_metadata_version=2
 await assert.rejects(units.resolveUnitLine(db,scope,product,{qty:2}),e=>e.status===409&&e.code==='UNIT_REVISION_CONFLICT')
 delete product.unit_metadata_version
 await assert.rejects(units.resolveUnitLine(db,scope,product,{qty:2}),e=>e.status===409&&e.code==='UNIT_METADATA_REVIEW_REQUIRED')
})
