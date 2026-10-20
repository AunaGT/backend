const test=require('node:test'),assert=require('node:assert/strict')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const {Prisma}=require('@prisma/client')
const model=require.resolve('../src/models/prisma')
const target=require.resolve('../src/modules/inventory/products.controller')
function fixture(){
  const product={id:'p',company_id:'A',name:'Producto',kind:'STANDARD',unit_metadata_version:2,supplier_id:'S',stock:'0',cost:'0',price:'10',quantity_decimals:0,base_unit_id:'u',unit_revision:1,tracks_expiry:true}
  const stored={incoming:[],items:[],logs:[],lots:[],movements:[],supplierTotal:new Prisma.Decimal(0),locks:[]}
  let chain=Promise.resolve()
  const db={
    $transaction:async fn=>{const before=chain;let release;chain=new Promise(r=>release=r);await before;const priorProduct={...product},prior={...stored,...Object.fromEntries(['incoming','items','logs','lots','movements'].map(key=>[key,structuredClone(stored[key])]))};try{return await fn(db)}catch(error){Object.assign(product,priorProduct);Object.assign(stored,prior);throw error}finally{release()}},
    $executeRaw:async (sql,...values)=>{stored.locks.push([String(sql),values]);return 1},
    $queryRaw:async(sql,...values)=>{
      const text=String(sql),v=values.flatMap(x=>x?.values||[])
      if(text.includes('SELECT l.id'))return[{id:'L'}]
      if(text.includes('UPDATE product_stock_locations'))return[{product_id:'p',location_id:'L',qty:v[2],balance:v[2]}]
      if(text.includes('UPDATE product_stocks')){product.stock=new Prisma.Decimal(product.stock).add(v[1]).toFixed();return[{id:'p',name:'Producto',stock:product.stock,min_stock:'0'}]}
      throw new Error('Unexpected SQL '+text)
    },
    systemSetting:{findUnique:async({where})=>({key:where.company_id_key.key,value:where.company_id_key.key==='inventory_units_enabled'?'true':'America/Guatemala'}),findMany:async()=>[]},
    supplier:{findFirst:async()=>({id:'S',supplier_payment_terms:[]}),findUnique:async()=>({id:'S'}),update:async({data})=>{if(data.total_purchases)stored.supplierTotal=stored.supplierTotal.add(data.total_purchases.increment);return {}}},
    product:{findMany:async()=>[{...product}],findFirst:async()=>({...product}),update:async({data})=>{Object.assign(product,data);return{...product}}},
    measureUnit:{findFirst:async()=>({id:'u',code:'unit',name:'Unidad',label:'u'})},
    productPresentation:{findFirst:async()=>({id:'box',version:1,name:'Caja',label:'caja',factor:'24',quantity_decimals:0,purchase_enabled:true})},
    incomingMerchandise:{
      create:async({data})=>{const row={id:`m${stored.incoming.length+1}`,...data};stored.incoming.push(row);return {...row}},
      findFirst:async({where})=>stored.incoming.find(r=>r.request_company_id===where.request_company_id&&r.registered_by===where.registered_by&&r.request_key===where.request_key)||null,
      update:async({where,data})=>Object.assign(stored.incoming.find(r=>r.id===where.id),data),
    },
    incomingMerchandiseItem:{create:async({data})=>{stored.items.push(data);return data}},
    purchaseLog:{create:async({data})=>{stored.logs.push(data);return data}},
    productLot:{create:async({data})=>{stored.lots.push(data);return data}},
    stockMovement:{createMany:async({data})=>stored.movements.push(...data)},
    status:{findFirst:async()=>null},alertType:{findMany:async()=>[],findFirst:async()=>null},alertPriority:{findMany:async()=>[]},
  }
  db.productStock={findMany:async()=>[{product_id:'p',stock:product.stock}]}
  const request=(items,key='one')=>({companyId:'A',branchId:'B',user:{sub:'U',permissions:['products.register_incoming']},body:{supplier_id:'S',request_key:key,items}})
  const item={product_id:'p',quantity:'2',unit_cost:'120',presentation_id:'box',unit_revision:1,expiry_date:'2027-01-01'}
  return{db,stored,product,request,item}
}
async function run(f,fn){await withMocks({[model]:{prisma:f.db,prismaTransaction:f.db}},target,async ctrl=>{
  await fn(async req=>{const res=jsonResponse();await ctrl.registerIncomingMerchandise(req,res,e=>{throw e});assert.equal(res.statusCode,200);return res.body})
})}

for(const [cost,amount]of [['0.005','0.01'],['0.004','0.00']])test(`purchase valuation uses final cents for editable cost ${cost}`,async()=>{
 const f=fixture()
 await run(f,async buy=>{
  await buy(f.request([{...f.item,quantity:'1',presentation_id:null,unit_cost:cost}]))
  assert.equal(f.stored.items[0].line_total,amount)
  assert.equal(f.product.cost,amount==='0.01'?'0.010000000000':'0.000000000000')
  assert.equal(f.stored.lots[0].unit_cost,f.product.cost)
  assert.equal(f.stored.items[0].base_unit_cost,f.product.cost)
  assert.equal(require('../src/modules/merchandise/payables/balance').balanceOf({items:f.stored.items}).balance,amount)
  assert.equal(f.stored.supplierTotal.toFixed(2),amount)
 })
})
test('duplicate-product receipt lines each conserve their rounded cents in average value',async()=>{
 const f=fixture()
 await run(f,async buy=>{await buy(f.request([1,2].map(()=>({...f.item,quantity:'1',presentation_id:null,unit_cost:'0.005'}))))})
 assert.equal(f.product.stock,'2');assert.equal(f.product.cost,'0.010000000000')
 assert.deepEqual(f.stored.items.map(i=>i.line_total),['0.01','0.01']);assert.equal(f.stored.supplierTotal.toFixed(2),'0.02')
})
test('accepted physical rounding divides final purchase cents by the accepted base quantity',async()=>{
 const f=fixture();f.product.quantity_decimals=6
 f.db.productPresentation.findFirst=async()=>({id:'lb',version:1,name:'Libra',label:'lb',factor:new Prisma.Decimal('0.45359237'),quantity_decimals:0,purchase_enabled:true})
 await run(f,async buy=>{await buy(f.request([{...f.item,quantity:'1',unit_cost:'0.005',presentation_id:'lb',accept_rounding:true}]))})
 assert.equal(f.stored.items[0].base_qty,'0.453592');assert.equal(f.stored.items[0].line_total,'0.01')
 assert.equal(f.product.cost,'0.022046244202');assert.equal(f.stored.lots[0].unit_cost,'0.022046244202')
})
for(const [name,company,branch,quantity]of [['branch','99999999','99999999','2'],['company','99999999','0','2']])test(`purchase rejects ${name} aggregate overflow before physical persistence`,async()=>{
 const f=fixture();f.product.stock=company;f.product.cost='0';f.db.productStock.findMany=async()=>[{product_id:'p',stock:branch}]
 await run(f,async buy=>{await assert.rejects(buy(f.request([{...f.item,quantity,presentation_id:null,unit_cost:'0'}])),e=>e.status===400)})
 assert.equal(f.product.stock,company);assert.equal(f.stored.movements.length,0);assert.equal(f.stored.lots.length,0)
 assert.equal(f.stored.incoming.length,0);assert.equal(f.stored.items.length,0);assert.equal(f.stored.supplierTotal.toFixed(),'0')
})
test('receiving exactly the aggregate maximum remains valid across another location',async()=>{
 const f=fixture();f.product.stock='99999999';f.product.quantity_decimals=6;f.product.cost='0'
 await run(f,async buy=>{await buy(f.request([{...f.item,quantity:'0.999999',presentation_id:null,unit_cost:'0'}]))})
 assert.equal(f.product.stock,'99999999.999999')
})

test('purchase two boxes preserves commercial Q240, receives 48 base units at Q5 and retries once',async()=>{
  const f=fixture()
  await run(f,async buy=>{
    const first=await buy(f.request([f.item]))
    assert.equal(first.totalPurchaseValue,'240.00')
    assert.equal(f.product.stock,'48')
    assert.equal(f.product.cost,'5.000000000000')
    assert.equal(f.stored.items[0].quantity,'2')
    assert.equal(f.stored.items[0].base_qty,'48')
    assert.equal(f.stored.items[0].unit_cost,'120')
    assert.equal(f.stored.items[0].line_total,'240.00')
    assert.equal(f.stored.lots[0].qty_received,'48')
    assert.equal(f.stored.lots[0].unit_cost,'5.000000000000')
    assert.deepEqual(await buy(f.request([f.item])),JSON.parse(JSON.stringify(first)))
    assert.equal(f.stored.incoming.length,1)
    assert.equal(f.product.stock,'48')
    assert.equal(f.stored.supplierTotal.toFixed(),'240')
    await assert.rejects(buy(f.request([{...f.item,quantity:'3'}])),e=>e.status===409&&e.code==='PURCHASE_REQUEST_CONFLICT')
  })
})

for (const [name,sellingPrice] of [['derived sale price','500000000'],['sale line amount','300000000']]) {
  test(`purchase-only presentation ignores unrelated ${name} overflow`,async()=>{
    const f=fixture();f.product.price=sellingPrice;f.product.available_for_sale=false
    f.db.productPresentation.findFirst=async()=>({id:'box',version:1,name:'Caja compra',label:'caja',factor:'24',quantity_decimals:0,purchase_enabled:true,sale_enabled:false})
    await run(f,async buy=>{
      const result=await buy(f.request([f.item]))
      assert.equal(result.totalPurchaseValue,'240.00')
      assert.equal(f.product.stock,'48')
      assert.equal(f.product.cost,'5.000000000000')
      assert.equal(f.stored.items[0].line_total,'240.00')
    })
    const line=await require('../src/modules/inventory/units').resolveUnitLine(f.db,{companyId:'A',branchId:'B',actorId:'U',permissions:['products.register_incoming']},f.product,{qty:'2',presentation_id:'box',unit_revision:1},{operation:'PURCHASE'})
    assert.equal(line.base_qty,'48')
    assert.equal(Object.hasOwn(line,'unit_price'),false)
    assert.equal(Object.hasOwn(line,'line_total'),false)
  })
}

test('mixed lines and concurrent purchases average exact base cost under the product lock',async()=>{
  const f=fixture()
  await run(f,async buy=>{
    await Promise.all([
      buy(f.request([{...f.item,quantity:'1'},{...f.item,quantity:'12',presentation_id:null,unit_cost:'6'}],'first')),
      buy(f.request([{...f.item,quantity:'1',unit_cost:'240'}],'second')),
    ])
    assert.equal(f.product.stock,'60')
    assert.equal(f.product.cost,'7.200000000000')
    assert.equal(f.stored.supplierTotal.toFixed(),'432')
    assert.equal(f.stored.incoming.length,2)
    assert(f.stored.locks.some(([sql])=>sql.includes('FOR UPDATE')))
  })
})

test('derived base purchase costs retain twelve decimals within their storage range',async()=>{
  const f=fixture();f.product.quantity_decimals=6
  f.db.productPresentation.findFirst=async()=>({id:'tiny',version:1,name:'Muestra',label:'muestra',factor:'0.000001',quantity_decimals:0,purchase_enabled:true})
  await run(f,async buy=>{
    await buy(f.request([{...f.item,quantity:'1',unit_cost:'12000',presentation_id:'tiny'}]))
    assert.equal(f.product.stock,'0.000001')
    assert.equal(f.product.cost,'12000000000.000000000000')
    assert.equal(f.stored.lots[0].unit_cost,'12000000000.000000000000')
  })
})

test('payable uses stored line amounts and commercial fractions without cent-rounding the unit cost',()=>{
  const {balanceOf}=require('../src/modules/merchandise/payables/balance')
  assert.equal(balanceOf({items:[{quantity:'0.3',unit_cost:'1.234567',line_total:'0.37'}]}).balance,'0.37')
  assert.equal(balanceOf({items:[{quantity:'0.3',unit_cost:'1.234567'}]}).balance,'0.37')
  assert.equal(balanceOf({items:[{quantity:2,unit_cost:'120.00'}]}).balance,'240.00')
})

test('payables aggregate frozen line totals and still read the pre-migration schema',async()=>{
  const {makePayablesFixture}=require('./helpers/payablesFixture.cjs')
  const f=makePayablesFixture();let statement
  f.db.$queryRaw=async sql=>{statement=sql.sql;return[]}
  await require('../src/modules/merchandise/payables/queries').listPayableEntries(f.db,f.scope,{page:1,pageSize:10})
  assert.match(statement,/SUM\(COALESCE\(\(to_jsonb\(i\)->>'line_total'\)::numeric,ROUND\(i.quantity\*i.unit_cost,2\)\)\)/)
})

test('legacy purchase needs no new models or request key and INITIAL stays outside supplier purchase totals',async()=>{
  const f=fixture();f.product.base_unit_id=null;f.product.unit_metadata_version=1;f.product.quantity_decimals=0
  f.db.systemSetting.findUnique=async({where})=>({key:where.company_id_key.key,value:'false'})
  delete f.db.measureUnit;delete f.db.productPresentation
  f.db.incomingMerchandise.findFirst=async()=>assert.fail('Legacy must not read idempotency columns')
  await run(f,async buy=>{
    const request=f.request([{product_id:'p',quantity:2,unit_cost:5.25,expiry_date:'2027-01-01'}]);delete request.body.request_key;request.body.is_initial_load=true
    const response=await buy(request)
    assert.equal(response.totalPurchaseValue,10.5)
    assert.equal(f.stored.items[0].quantity,2)
    assert.equal(f.stored.items[0].unit_snapshot,undefined)
    assert.equal(f.stored.supplierTotal.toFixed(),'0')
  })
})
