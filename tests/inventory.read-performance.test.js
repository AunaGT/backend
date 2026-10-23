const test=require('node:test'),assert=require('node:assert/strict')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs'),{matches,project}=require('./helpers/labelReadFixture.cjs')
const model=require.resolve('../src/models/prisma'),target=require.resolve('../src/modules/inventory/products.controller')
function fixture(){
 const rows=Array.from({length:10},(_,i)=>({id:String(i).padStart(2,'0'),company_id:'A',name:'Producto',kind:i<2?'KIT':'STANDARD',available_for_sale:i<6,tracks_expiry:i<3,quantity_decimals:0,deleted:false,stock:'999',min_stock:'1',price:'0.125',category:{name:'Bebidas'},brand:'Marca',barcode:'000'+i,branch_stocks:[{branch_id:'B'}],location_stocks:[{stock:1,location_id:'L',location:{warehouse:{id:'W',branch_id:'B'}}}]}))
 rows.push(...Array.from({length:5},(_,i)=>({...rows[0],id:'S'+i,name:'Servicio',kind:'SERVICE',available_for_sale:i<3,quantity_decimals:i<2?2:0,tracks_expiry:false,branch_stocks:[]})))
 const calls=[]
 const db={systemSetting:{findUnique:async()=>({value:'true'})},product:{count:async({where})=>{calls.push({method:'count',where});return rows.filter(r=>matches(r,where)).length},groupBy:async({where,by})=>{calls.push({method:'group',where,by});const map=new Map();for(const row of rows.filter(r=>matches(r,where))){const values=Object.fromEntries(by.map(key=>[key,row[key]])),k=JSON.stringify(values),entry=map.get(k)??{...values,_count:{_all:0}};entry._count._all++;map.set(k,entry)}return[...map.values()]},findMany:async q=>{calls.push({method:'page',...q});return rows.filter(r=>matches(r,q.where)).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id)).slice(q.skip,q.skip+q.take).map(r=>project(r,q.select))}},productStock:{findMany:async q=>rows.filter(r=>q.where.product_id.in.includes(r.id)).map(r=>({product_id:r.id,stock:'1.125',min_stock:'0.001'}))},productStockLocation:{findMany:async()=>[{product_id:'00',stock:'0.125',min_stock:'0.001'}]}}
 const run=query=>withMocks({[model]:{prisma:db,prismaTransaction:db}},target,async c=>{const res=jsonResponse();await c.list({companyId:'A',branchId:'B',userBranchIds:['B'],query},res,e=>{throw e});return res.body})
 return{rows,calls,run}
}
test('inventory metrics and pagination use one scoped grouping and no extra counts',async()=>{
 const f=fixture(),r=await f.run({includeSummary:'true',page:'999',pageSize:'3'})
 assert.deepEqual(r.summary,{total:10,forSale:6,kits:2,tracksExpiry:3});assert.equal(r.page,4);assert.deepEqual(r.items.map(p=>p.id),['09']);assert.equal(r.items[0].stock,'1.125');assert.equal(r.items[0].price,'0.125')
 assert.deepEqual(f.calls.map(c=>c.method),['group','page']);assert.deepEqual(f.calls[1].orderBy,[{name:'asc'},{id:'asc'}]);assert.deepEqual(f.calls[0].where,f.calls[1].where)
})
test('service grouped metrics preserve fractional counts with no physical stock overlay',async()=>{
 const f=fixture(),r=await f.run({catalog_type:'services',includeSummary:'true'})
 assert.deepEqual(r.summary,{total:5,forSale:3,notForSale:2,fractional:2});assert.ok(r.items.every(p=>p.kind==='SERVICE'));assert.deepEqual(f.calls.map(c=>c.method),['group','page'])
})
test('empty summary and legacy no-summary calls preserve their response and pagination contracts',async()=>{
 const f=fixture();let r=await f.run({includeSummary:'true',search:'No existe'})
 assert.deepEqual(r.summary,{total:0,forSale:0,kits:0,tracksExpiry:0});assert.equal(r.page,1);assert.deepEqual(r.items,[])
 f.calls.length=0;r=await f.run({pageSize:'2'});assert.equal(r.summary,undefined);assert.equal(r.totalItems,10);assert.deepEqual(f.calls.map(c=>c.method),['count','page'])
})
test('grouping filters company, archived, text and physical scope before counting',async()=>{
 const f=fixture();f.rows.push({...f.rows[0],id:'OTHER',company_id:'OTHER'});f.rows.push({...f.rows[0],id:'DELETED',deleted:true})
 let r=await f.run({includeSummary:'true',search:'Marca',category:'Bebidas',branch_id:'B',in_branch:'true',warehouse_id:'W',location_id:'L'})
 assert.equal(r.summary.total,10);assert.equal(r.items[0].stock,'0.125');assert.deepEqual(f.calls[0].where,f.calls[1].where);assert.equal(f.calls[0].where.company_id,'A');assert.ok(f.calls[0].where.location_stocks)
 f.calls.length=0;r=await f.run({includeSummary:'true',deletedOnly:'true'});assert.equal(r.summary.total,1);assert.equal(r.items[0].id,'DELETED')
 await assert.rejects(f.run({includeSummary:'true',branch_id:'OTHER'}),e=>e.status===403)
})
test('detail supplies authoritative base lock for legacy products with and without history, only when units are enabled',async()=>{
 for(const [enabled,history,expected] of [[true,false,false],[true,true,true],[false,false,undefined]]){
  const reads=[],row={id:'P',company_id:'A',name:'Legacy',kind:'STANDARD',deleted:false,base_unit_id:null,quantity_decimals:0,unit_revision:1}
  const db={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:String(enabled)})},product:{findFirst:async({where})=>{assert.deepEqual(where,{id:'P',company_id:'A'});return row}},productPresentation:{findFirst:async({where})=>{reads.push('presentations');assert.equal(where.company_id,'A');return null}}}
  for(const modelName of ['saleItem','commercialDocumentLine','purchaseLog','incomingMerchandiseItem','stockMovement','productLot','stockTransferLine','inventoryCountLine','returnItem','returnReplacementItem','orderDeliveryLine','stockReservation','appointmentEngagementLine','appointmentSession','productBomLine','productStock','productStockLocation'])db[modelName]={findFirst:async()=>{reads.push(modelName);return history&&modelName==='saleItem'?{id:'H'}:null}}
  await withMocks({[model]:{prisma:db}},target,async c=>{const res=jsonResponse();await c.getOne({companyId:'A',params:{id:'P'}},res,e=>{throw e});assert.equal(res.body.base_unit_locked,expected);assert.equal(res.body.unit_revision,1)})
  assert.equal(reads.length>0,enabled)
 }
})
