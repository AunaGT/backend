const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const file=path.join(__dirname,'../src/modules/inventory/units/previewBatch.js'),api=()=>fs.existsSync(file)?require(file):{}
const C='10000000-0000-4000-8000-000000000001',B='10000000-0000-4000-8000-000000000002',P='20000000-0000-4000-8000-000000000001',Q='20000000-0000-4000-8000-000000000002',U='30000000-0000-4000-8000-000000000001',BOX='40000000-0000-4000-8000-000000000001'
const scope={companyId:C,branchId:B,permissions:['sales.create'],actorId:'actor'}
function fixture(){
 const locks=[],p={id:P,company_id:C,deleted:false,kind:'STANDARD',name:'Tornillo',unit_metadata_version:2,base_unit_id:U,quantity_decimals:0,unit_revision:3,price:'2',available_for_sale:true}
 const box={id:BOX,company_id:C,product_id:P,version:1,name:'Caja',label:'caja',factor:'3',quantity_decimals:0,active:true,sale_enabled:true}
 const db={$executeRaw:async(_strings,...args)=>{locks.push(...args.flatMap(arg=>arg?.values||[]));return 1},systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'})},product:{findFirst:async({where})=>where.company_id===C&&[P,Q].includes(where.id)?{...p,id:where.id}:null},measureUnit:{findFirst:async()=>({id:U,company_id:C,code:'UNIT',name:'Unidad',label:'ud',quantity_decimals:0})},productPresentation:{findFirst:async({where})=>where.id===BOX&&box.active?box:null}}
 db.product.findMany=async({where})=>(await Promise.all(where.id.in.map(id=>db.product.findFirst({where:{id,company_id:where.company_id}})))).filter(Boolean)
 db.measureUnit.findMany=async()=>[await db.measureUnit.findFirst()]
 db.productPresentation.findMany=async({where})=>where.company_id===C&&where.id.in.includes(BOX)&&box.active?[box]:[]
 return{locks,box,db}
}
const line=(key='base',product=P)=>({client_line_key:key,product_id:product,qty:'2',unit_revision:3,presentation_id:null})
test('batch resolves multiple presentations with real unit math, stable prelocks and input order',async()=>{
 assert.equal(typeof api().previewUnitBatch,'function');const h=fixture()
 const result=await api().previewUnitBatch(h.db,scope,{lines:[line('second',Q),{...line('box'),presentation_id:BOX},line()]})
 assert.deepEqual(h.locks.slice(0,2),[P,Q]);assert.deepEqual(result.items.map(i=>i.client_line_key),['second','box','base'])
 assert.equal(result.items[1].preview.base_qty,'6');assert.equal(result.items[1].preview.unit_price,'6');assert.equal(result.items[2].preview.base_qty,'2')
})
test('preview groups product and unit reads independently of line count',async()=>{
 const h=fixture();let products=0,units=0
 h.db.product.findMany=async({where})=>{products++;return Promise.all(where.id.in.map(id=>h.db.product.findFirst({where:{id,company_id:where.company_id}}))).then(rows=>rows.filter(Boolean))}
 h.db.measureUnit.findMany=async()=>{units++;return[await h.db.measureUnit.findFirst()]}
 h.db.productPresentation.findMany=async()=>[h.box]
 await api().previewUnitBatch(h.db,scope,{lines:Array.from({length:10},(_,i)=>line(String(i)))})
 assert.equal(products,2);assert.equal(units,1)
})
test('batch validates every input before locks, limits 200 and forbids injected fields or duplicate keys',async()=>{
 assert.equal(typeof api().parsePreviewBatch,'function')
 for(const lines of [[],Array.from({length:201},(_,i)=>line(String(i))),[line(),line()],[{...line(),factor:'99'}],[{...line(),product_id:'foreign'}],[{...line(),accept_rounding:'true'}],[{...line(),qty:'0'}]]){
  const h=fixture();await assert.rejects(api().previewUnitBatch(h.db,scope,{lines}),e=>e.status===400);assert.equal(h.locks.length,0)
 }
 assert.equal(api().parsePreviewBatch({lines:Array.from({length:200},(_,i)=>line(String(i)))}).lines.length,200)
})
test('batch rejects disabled access, foreign product, changed revision and archived presentation',async()=>{
 assert.equal(typeof api().previewUnitBatch,'function')
 for(const [s,body,status]of [[{...scope,permissions:[]},{lines:[line()]},403],[{...scope,companyId:'other'},{lines:[line()]},404],[scope,{lines:[{...line(),unit_revision:2}]},409]])await assert.rejects(api().previewUnitBatch(fixture().db,s,body),e=>e.status===status)
 const h=fixture();h.box.active=false;await assert.rejects(api().previewUnitBatch(h.db,scope,{lines:[{...line(),presentation_id:BOX}]}),e=>e.status===404)
})
test('batch respects the same explicit rounding acceptance and current promotion date as individual lines',async()=>{
 const h=fixture();h.box.factor='0.45359237';const read=h.db.product.findFirst;h.db.product.findFirst=async args=>({...await read(args),quantity_decimals:6});h.db.measureUnit.findFirst=async()=>({id:U,company_id:C,code:'KG',name:'Kilogramo',label:'kg',quantity_decimals:6})
 const input={...line(),qty:'1',presentation_id:BOX}
 await assert.rejects(api().previewUnitBatch(h.db,scope,{lines:[input]}),e=>e.code==='QUANTITY_ROUNDING_REQUIRED')
 h.box.price_promotion='1';h.box.promotion_valid_until=new Date('2020-01-01')
 const result=await api().previewUnitBatch(h.db,scope,{lines:[{...input,accept_rounding:true,price_tier:'PROMOTION'}]})
 assert.equal(result.items[0].preview.base_qty,'0.453592');assert.equal(result.items[0].preview.unit_price,'0.90718474');assert.equal(result.items[0].preview.unit_snapshot.roundingDelta,'-0.00000037')
})
