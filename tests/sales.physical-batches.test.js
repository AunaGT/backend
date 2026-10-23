const test=require('node:test'),assert=require('node:assert/strict')
const {Prisma}=require('@prisma/client')
const {persistSalePhysicalSnapshots}=require('../src/services/units/commercialPhysical')
const {consumeLotsFEFO}=require('../src/services/lots')
for(const count of [1,3,10,201])test(`physical snapshots persist ${count} exact line costs in bounded writes`,async()=>{
 const items=Array.from({length:count},()=>({qty:'3',base_qty:'6',unit_snapshot:{version:2},unit_metadata_version:2,item_kind:'STANDARD'}))
 const snapshots=items.map(()=>({version:1,entries:[{product_id:'P',base_qty:'6',base_unit_cost:'1.123456789012'}]}))
 const saved=items.map((_,i)=>({id:i+1,sale_id:'SALE'})),writes=[]
 const tx={saleItem:{findMany:async({where})=>{assert.equal(where.sale_id,'SALE');return saved},update:async()=>assert.fail('per-row update')},$queryRaw:async(strings,...args)=>{
  assert.match(String(strings),/sale_id/);assert.equal(args.at(-1),'SALE')
  const values=args[0].values;writes.push(values)
  for(let i=0;i<values.length;i+=5){assert.equal(values[i+2],'2.246913578024');assert.equal(values[i+3],'1.123456789012');assert.equal(values[i+4],true);assert.deepEqual(JSON.parse(values[i+1]),snapshots[0])}
  return Array.from({length:values.length/5},(_,i)=>({id:values[i*5]}))
 }}
 await persistSalePhysicalSnapshots(tx,'SALE',items,snapshots)
 assert.equal(writes.length,Math.ceil(count/200));assert(writes.every(v=>v.length<=1000))
})
test('snapshot update refuses partial or foreign sale targets',async()=>{
 const tx={saleItem:{findMany:async()=>[{id:1}],update:async()=>{}},$queryRaw:async()=>[]}
 await assert.rejects(persistSalePhysicalSnapshots(tx,'SALE',[{qty:'1',item_kind:'STANDARD'}],[{entries:[]}]),e=>e.status===409)
})
function lotFixture({short=false,partial=false}={}){
 const lots=[{id:'L',product_id:'P',branch_id:'B',location_id:null,qty_remaining:short?'1':'4',lot_code:'A',received_at:new Date(),unit_cost:'2.123456789012'}],writes=[]
 return {lots,writes,tx:{product:{findMany:async()=>[{id:'P',kind:'STANDARD',tracks_expiry:true}],findUnique:async()=>({name:'Producto'})},productLot:{findMany:async()=>lots.map(l=>({...l})),update:async()=>assert.fail('per-lot write')},$queryRaw:async(strings,...args)=>{
  assert.match(String(strings),/qty_remaining >=/);assert.equal(args.at(-1),'B');const v=args[0].values;writes.push(v)
  assert.deepEqual(v,['L','3','P']);if(partial)return[]
  lots[0].qty_remaining=new Prisma.Decimal(lots[0].qty_remaining).sub(v[1]).toFixed();return[{id:'L'}]
 }}}
}
test('FEFO aggregates a shared legacy lot across locations without losing exact snapshots',async()=>{
 const f=lotFixture(),out=await consumeLotsFEFO(f.tx,new Map([['P','3']]),'B',new Map([['P',[{location_id:'A',qty:'1'},{location_id:'Z',qty:'2'}]]]))
 assert.equal(f.writes.length,1);assert.equal(f.lots[0].qty_remaining,'1')
 assert.deepEqual(out.get('P').map(l=>[l.location_id,String(l.qty),l.unit_cost]),[['A','1','2.123456789012'],['Z','2','2.123456789012']])
})
test('FEFO refuses short tracked coverage before writing and rejects a partial guarded update',async()=>{
 const f=lotFixture({short:true});await assert.rejects(consumeLotsFEFO(f.tx,new Map([['P','3']]),'B'),e=>e.status===409);assert.equal(f.writes.length,0);assert.equal(f.lots[0].qty_remaining,'1')
 const partial=lotFixture({partial:true});await assert.rejects(consumeLotsFEFO(partial.tx,new Map([['P','3']]),'B'),e=>e.status===409)
})
