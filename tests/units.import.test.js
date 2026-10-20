const test=require('node:test'),assert=require('node:assert/strict')
const {withMocks}=require('./helpers/reportHarness.cjs'),model=require.resolve('../src/models/prisma')
const row={nombre:'Producto',categoria:'General',proveedor:'Proveedor',precio:'1',costo:'0.123456',stock:'1.123456',stock_minimo:'0.123456',base_unit_code:'KG',quantity_decimals:'6'}
for(const [factor,stock]of [['0.0000001','10'],['0.000000000001','1000000']])test(`real stored Decimal factor ${factor} survives import dryrun and confirmation`,async()=>{
 const {Prisma}=require('@prisma/client'),prisma=db(),product={id:'p',company_id:'A',barcode:'BASE',kind:'STANDARD',unit_metadata_version:2,base_unit_id:'kg',quantity_decimals:6,stock:'0'},writes=[]
 prisma.product.findMany=async({where})=>where.barcode?[product]:[];prisma.product.findFirst=async()=>product;prisma.product.update=async({data})=>writes.push(data)
 prisma.measureUnit.findFirst=async()=>({id:'kg',code:'KG',name:'Kilogramo',label:'kg',family:'MASS',quantity_decimals:6})
 prisma.productBarcode={findMany:async()=>[{presentation_id:'tiny'}]};prisma.productPresentation={findFirst:async()=>({id:'tiny',factor:new Prisma.Decimal(factor),quantity_decimals:0,active:true,label:'muestra'})}
 prisma.$transaction=fn=>fn(prisma);prisma.$executeRaw=async()=>0;prisma.productStock={findUnique:async()=>({stock:0,min_stock:0}),update:async({data})=>writes.push(data)}
 const physical=require.resolve('../src/services/units/physical')
 await withMocks({[model]:{prisma,prismaTransaction:prisma},[physical]:{...require(physical),lockPhysicalProducts:async()=>new Map([['p',product]])},[require.resolve('../src/services/stockLocations')]:{applyBranchDelta:async()=>{}}},require.resolve('../src/services/bulkImport'),async c=>{
  const input={...row,codigo_barras:'BASE',presentation_code:'TINY',presentation_content:factor,stock,stock_minimo:'0'}
  const dry=await c.validateBulkData([input],{}, {companyId:'A'});assert.equal(dry.totals.valid,1,JSON.stringify(dry.invalidRows));assert.equal(dry.validRows[0].unitPreview.baseStock,'0.000001')
  const confirmed=await c.bulkCreateProducts(dry.validRows,{companyId:'A',branchId:'B'});assert.equal(confirmed.adopted,1,JSON.stringify(confirmed.errors));assert.ok(writes.some(d=>d.stock==='0.000001'))
  const invalid=await c.validateBulkData([{...input,presentation_content:'1e-7'}],{}, {companyId:'A'});assert.equal(invalid.totals.invalid,1)
 })
})
function db(){return {systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'})},productCategory:{findMany:async()=>[{id:1,name:'General'}]},supplier:{findMany:async()=>[{id:'supplier',name:'Proveedor'}]},product:{findMany:async()=>[],findFirst:async()=>null},measureUnit:{findFirst:async({where})=>where.company_id==='A'&&where.code==='KG'?{id:'kg',code:'KG',label:'kg',family:'MASS',quantity_decimals:6}:null}}}
for(const enabled of [true,false])test(`import direct SET enforces company stock maximum with units ${enabled}`,async()=>{
 const prisma=db(),writes=[],product={id:'p',company_id:'A',kind:'STANDARD',unit_metadata_version:1,stock:'99999999',quantity_decimals:0,base_unit_id:null}
 prisma.systemSetting.findUnique=async()=>({key:'inventory_units_enabled',value:String(enabled)})
 prisma.$executeRaw=async()=>0;prisma.$transaction=fn=>fn(prisma)
 prisma.product.findFirst=async()=>product;prisma.product.findMany=async()=>[product];prisma.product.update=async({data})=>writes.push(data)
 prisma.productStock={findMany:async()=>[{product_id:'p',stock:'0'}],findUnique:async()=>({stock:0,min_stock:0}),update:async({data})=>writes.push(data)}
 await withMocks({[model]:{prisma,prismaTransaction:prisma}},require.resolve('../src/services/bulkImport'),async c=>{
  const result=await c.bulkCreateProducts([{rowIndex:2,existingProductId:'p',data:{stock:2,min_stock:0,kind:'STANDARD'}}],{companyId:'A',branchId:'B'})
  assert.equal(result.adopted,0);assert.equal(result.skipped,1);assert.match(result.errors[0].error,/rango|máxim|cantidad/i);assert.deepEqual(writes,[])
 })
})
test('flag-off new legacy import cannot reuse an archived registered barcode after schema deployment',async()=>{
 const prisma=db(),created=[]
 prisma.systemSetting.findUnique=async()=>({key:'inventory_units_enabled',value:'false'})
 prisma.productBarcode={findFirst:async()=>({company_id:'A',product_id:'OTHER',presentation_id:null,code:'OLD',active:false})}
 prisma.$transaction=async run=>run(prisma);prisma.$executeRaw=async()=>0
 prisma.product.create=async({data})=>{created.push(data);return{id:'new'}};prisma.productStock={create:async()=>{}}
 await withMocks({[model]:{prisma,prismaTransaction:prisma}},require.resolve('../src/services/bulkImport'),async c=>{
  const result=await c.bulkCreateProducts([{rowIndex:2,data:{kind:'STANDARD',name:'Legacy',barcode:'OLD',category_id:1,supplier_id:'supplier',price:1,cost:1,stock:0,min_stock:0}}],{companyId:'A',branchId:'B'})
  assert.equal(result.created,0);assert.equal(result.skipped,1);assert.equal(created.length,0)
  assert.match(result.errors[0].error,/reservado|código/i)
 })
})
test('actual import dryrun preserves new measured stock, base price and six-place base cost without writes',async()=>{
  const prisma=db();await withMocks({[model]:{prisma}},require.resolve('../src/services/bulkImport'),async c=>{const result=await c.validateBulkData([row],{}, {companyId:'A'});assert.equal(result.totals.valid,1);assert.equal(result.validRows[0].data.stock,'1.123456');assert.equal(result.validRows[0].data.cost,'0.123456');assert.match(result.validRows[0].unitPreview.priceCostPolicy,/base/);assert.equal(result.validRows[0].unitPreview.unitLabel,'kg')})
})
test('unknown or foreign import unit fails its row in dryrun before any writes',async()=>{
  const prisma=db();await withMocks({[model]:{prisma}},require.resolve('../src/services/bulkImport'),async c=>{const result=await c.validateBulkData([{...row,stock:'1',stock_minimo:'0',costo:'1',base_unit_code:'FOREIGN'}],{}, {companyId:'A'});assert.equal(result.totals.invalid,1);assert.match(result.invalidRows[0].errors.join(' '),/unidad.*empresa|unidad.*encontrada/i)})
})
test('registered presentation imports set stock/min once in base and announce existing prices/cost unchanged',async()=>{
  const prisma=db();prisma.product.findMany=async({where})=>where.barcode?[{id:'p',barcode:'BASE',kind:'STANDARD',unit_metadata_version:2,base_unit_id:'unit',quantity_decimals:0}]:[];prisma.product.findFirst=async()=>({id:'p',company_id:'A',kind:'STANDARD',unit_metadata_version:2,base_unit_id:'unit',quantity_decimals:0});prisma.measureUnit.findFirst=async()=>({id:'unit',code:'UNIT',label:'unidades',quantity_decimals:0});prisma.productBarcode={findMany:async()=>[{presentation_id:'box'}]};prisma.productPresentation={findFirst:async()=>({id:'box',factor:'24',quantity_decimals:0,active:true,label:'caja'})}
  await withMocks({[model]:{prisma}},require.resolve('../src/services/bulkImport'),async c=>{const input={...row,codigo_barras:'BASE',base_unit_code:'UNIT',presentation_code:'BOX24',presentation_content:'24',quantity_decimals:'0',stock:'2',stock_minimo:'1',costo:'1'};const good=await c.validateBulkData([input],{}, {companyId:'A'});assert.equal(good.totals.valid,1);assert.equal(good.validRows[0].unitPreview.baseStock,'48');assert.equal(good.validRows[0].unitPreview.baseMinimum,'24');assert.match(good.validRows[0].unitPreview.priceCostPolicy,/sin cambios/);const bad=await c.validateBulkData([{...input,presentation_content:'12'}],{}, {companyId:'A'});assert.equal(bad.totals.invalid,1)})
})
test('new configured product and initial location stock roll back together when physical write fails',async()=>{
  const prisma=db(),state={products:[],stocks:[]};let configuration;prisma.$executeRaw=async()=>0
  prisma.product.create=async({data})=>{const p={id:'new',...data};state.products.push(p);return p};prisma.product.update=async()=>({});prisma.productStock={create:async({data})=>state.stocks.push(data)}
  prisma.$transaction=async fn=>{const original=structuredClone(state);try{return await fn(prisma)}catch(error){Object.assign(state,original);throw error}}
  const unitsPath=require.resolve('../src/modules/inventory/units'),realUnits=require(unitsPath)
  await withMocks({[model]:{prisma,prismaTransaction:prisma},[unitsPath]:{...realUnits,prepareProductWrite:async(tx,scope,current,input,data,options)=>{configuration=structuredClone(input.units_configuration);assert.equal(tx,prisma);assert.equal(options.create,true);delete data.units_configuration;return async p=>p}},[require.resolve('../src/services/stockLocations')]:{applyBranchDelta:async()=>{throw Error('physical failure')}}},require.resolve('../src/services/bulkImport'),async c=>{
    const checked=await c.validateBulkData([row],{}, {companyId:'A'});assert.equal(checked.totals.valid,1)
    const result=await c.bulkCreateProducts(checked.validRows,{companyId:'A',branchId:'B'});assert.equal(result.created,0);assert.equal(result.skipped,1);assert.match(result.errors[0].error,/physical failure/);assert.deepEqual(state,{products:[],stocks:[]});assert.equal(configuration.base_unit_id,'kg')
  })
})
test('activation revoked between dryrun and confirm cannot silently create a legacy product',async()=>{
  const prisma=db(),created=[];prisma.systemSetting.findUnique=async()=>({key:'inventory_units_enabled',value:'false'});prisma.product.create=async({data})=>{created.push(data);return{id:'p'}};prisma.productStock={create:async()=>{}}
  await withMocks({[model]:{prisma},[require.resolve('../src/services/stockLocations')]:{applyBranchDelta:async()=>{}}},require.resolve('../src/services/bulkImport'),async c=>{const result=await c.bulkCreateProducts([{rowIndex:2,unitImport:{base_unit_code:'KG'},data:{kind:'STANDARD',name:'Producto',price:'1',stock:0,min_stock:0,cost:0}}],{companyId:'A',branchId:'B'});assert.equal(result.created,0);assert.equal(created.length,0)})
})
test('confirmed existing box24 sets 48 base units once and leaves catalog price/cost unchanged',async()=>{
  const prisma=db(),writes=[],deltas=[],product={id:'p',company_id:'A',kind:'STANDARD',unit_metadata_version:2,base_unit_id:'unit',quantity_decimals:0}
  prisma.$executeRaw=async()=>0;prisma.$transaction=fn=>fn(prisma);prisma.product.findFirst=async()=>product;prisma.product.update=async args=>writes.push(args.data);prisma.productStock={findUnique:async()=>({stock:0,min_stock:0}),update:async args=>writes.push(args.data)}
  prisma.measureUnit.findFirst=async()=>({id:'unit',code:'UNIT',name:'Unidad',label:'unidades',quantity_decimals:0});prisma.productBarcode={findMany:async()=>[{presentation_id:'box'}]};prisma.productPresentation={findFirst:async()=>({factor:'24',quantity_decimals:0,active:true,label:'caja'})}
  const physicalPath=require.resolve('../src/services/units/physical'),realPhysical=require(physicalPath)
  await withMocks({[model]:{prisma,prismaTransaction:prisma},[physicalPath]:{...realPhysical,lockPhysicalProducts:async()=>new Map([['p',product]])},[require.resolve('../src/services/stockLocations')]:{applyBranchDelta:async(tx,lines)=>{assert.equal(tx,prisma);deltas.push(lines)}}},require.resolve('../src/services/bulkImport'),async c=>{
    const result=await c.bulkCreateProducts([{rowIndex:2,existingProductId:'p',unitImport:{base_unit_code:'UNIT',presentation_code:'BOX24',presentation_content:'24',quantity_decimals:'0'},data:{stock:'2',min_stock:'1',price:'999',cost:'888',kind:'STANDARD'}}],{companyId:'A',branchId:'B'})
    assert.equal(result.adopted,1);assert.deepEqual(deltas,[[['p',48]]]);assert.ok(writes.some(w=>w.stock===48));assert.ok(writes.every(w=>!Object.hasOwn(w,'cost')&&!Object.hasOwn(w,'price')))
  })
})
test('flag-off legacy import preserves integer stock and never queries new unit models',async()=>{
  const prisma=db();prisma.systemSetting.findUnique=async()=>({key:'inventory_units_enabled',value:'false'});prisma.measureUnit.findFirst=async()=>assert.fail('new unit model queried')
  await withMocks({[model]:{prisma}},require.resolve('../src/services/bulkImport'),async c=>{const result=await c.validateBulkData([{nombre:'Producto',categoria:'General',proveedor:'Proveedor',precio:'1.25',stock:2,costo:'1'}],{}, {companyId:'A'});assert.equal(result.totals.valid,1);assert.equal(result.validRows[0].data.stock,2);assert.equal(result.validRows[0].data.price,1.25)})
})
test('actual import template exposes unit codes, verified content and clear base cost/stock basis',async()=>{
  const prisma=db();prisma.measureUnit.findMany=async()=>[{code:'KG',label:'kg',family:'MASS',quantity_decimals:6,factor:'1000'}]
  await withMocks({[model]:{prisma}},require.resolve('../src/services/bulkImport'),async c=>{
    const XLSX=require('xlsx'),bytes=await c.generateTemplateWithCatalogs('A'),wb=XLSX.read(bytes,{type:'buffer',cellStyles:true}),header=XLSX.utils.sheet_to_json(wb.Sheets.Productos,{header:1})[0]
    if(process.env.TASK7_IMPORT_OUTPUT)require('node:fs').writeFileSync(process.env.TASK7_IMPORT_OUTPUT,bytes)
    assert.ok(header.includes('base_unit_code'));assert.ok(header.includes('presentation_code'));assert.ok(header.includes('presentation_content'))
    assert.equal(wb.Sheets.Productos.J2.t,'s');assert.equal(wb.Sheets.Productos.J2.z,'@');assert.match(wb.Sheets.Productos.J2.v,/^0/);assert.ok(wb.Sheets.Productos['!cols'][18].wch>=22)
    const instructions=XLSX.utils.sheet_to_json(wb.Sheets.Unidades,{header:1}).flat().join(' ');assert.match(instructions,/costo.*unidad base/i);assert.match(instructions,/sin cambios/i);assert.match(instructions,/stock.*mínimo.*misma/i)
  })
})
