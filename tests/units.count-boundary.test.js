const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module')
const {Prisma}=require('@prisma/client'),{withMocks}=require('./helpers/reportHarness.cjs')
const D=value=>new Prisma.Decimal(value)
function fixture({company='0',branch='2',locations={A:'2',B:'0'},targets={A:'0',B:'2'}}={}){
 let state={company,branch,locations:{...locations},movements:[],status:null},locked=false
 const product=()=>({id:'p',kind:'STANDARD',company_id:'company',unit_metadata_version:1,base_unit_id:null,quantity_decimals:6,stock:state.company,min_stock:'0'})
 const tx={
  product:{findMany:async()=>[product()],update:async({data})=>{state.status=data.status_id;return product()}},
  productStock:{findMany:async()=>{assert(locked,'aggregate read must hold product lock');return[{product_id:'p',stock:state.branch}]}},
  productStockLocation:{findMany:async()=>Object.entries(state.locations).map(([location_id,stock])=>({product_id:'p',location_id,stock}))},
  inventoryCountLine:{findMany:async()=>Object.entries(targets).map(([location_id,qty_counted])=>({product_id:'p',location_id,qty_counted,product:product()}))},
  stockStatus:{findMany:async()=>[{id:1,name:'Disponible'},{id:2,name:'Bajo'},{id:3,name:'Agotado'}]},
  stockMovement:{createMany:async({data})=>state.movements.push(...data)},
  $executeRaw:async(sql)=>{if(String(sql).includes('FROM products')&&String(sql).includes('FOR UPDATE'))locked=true;return 1},
  $queryRaw:async(sql,...args)=>{
   const text=String(sql),values=args.flatMap(v=>v?.values||[v])
   if(text.includes('SELECT l.id'))return Object.keys(state.locations).filter(id=>values.includes(id)).map(id=>({id}))
   if(text.includes('UPDATE product_stock_locations')){
    const result=[]
    for(let i=0;i<values.length;i+=3){const [product_id,location_id,qty]=values.slice(i,i+3);state.locations[location_id]=D(state.locations[location_id]??0).add(qty).toFixed();result.push({product_id,location_id,qty,balance:state.locations[location_id]})}
    return result
   }
   if(text.includes('UPDATE product_stocks')){
    for(let i=0;i<values.length-1;i+=2){const qty=values[i+1];state.company=D(state.company).add(qty).toFixed();state.branch=D(state.branch).add(qty).toFixed()}
    return[{id:'p',product_id:'p',stock:state.branch,min_stock:'0'}]
   }
   throw Error('Unexpected persistence query '+text)
  },
 }
 const transaction=async run=>{const before=structuredClone(state);try{return await run(tx)}catch(e){state=before;throw e}}
 return{tx,transaction,get state(){return state}}
}
async function count(f){
 const model=require.resolve('../src/models/prisma'),file=require.resolve('../src/modules/inventory-count/controller')
 await withMocks({[model]:{prisma:f.tx,prismaTransaction:f.tx}},file,async()=>{
  const mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(require('node:path').dirname(file))
  mod._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports.applyStockTransactionForTest=applyStockTransaction\n',file)
  await f.transaction(tx=>mod.exports.applyStockTransactionForTest(tx,'count','branch'))
 })
}
for(const company of ['99999999.999999','-99999999','-99999999.999999'])test(`actual count redistributes two locations at signed company boundary ${company}`,async()=>{
 const f=fixture({company});await count(f)
 assert.equal(f.state.company,company);assert.equal(f.state.branch,'2');assert.deepEqual(f.state.locations,{A:'0',B:'2'})
 assert.equal(f.state.movements.length,2);assert.deepEqual(f.state.movements.map(m=>String(m.qty)).sort(),['-2','2'])
})
for(const branch of ['99999999.999999','-99999999.999999'])test(`actual count redistributes at signed branch boundary ${branch}`,async()=>{
 const c=branch.startsWith('-')?'-50000000':'50000000'
 const locations={A:'2',B:'0',C:c,D:D(branch).sub(2).sub(c).toFixed()}
 const f=fixture({company:'0',branch,locations});await count(f)
 assert.equal(f.state.company,'0');assert.equal(f.state.branch,branch);assert.deepEqual(f.state.locations,{...locations,A:'0',B:'2'})
})
test('actual count accepts its exact final company and branch upper bound',async()=>{
 const f=fixture({company:'99999999',branch:'99999999',locations:{A:'99999999',B:'0'},targets:{A:'99999999',B:'0.999999'}})
 await count(f);assert.equal(f.state.company,'99999999.999999');assert.equal(f.state.branch,'99999999.999999');assert.equal(f.state.locations.B,'0.999999')
})
for(const options of [
 {company:'99999999',targets:{A:'2',B:'2'}},
 {company:'-99999999',targets:{A:'0',B:'0'}},
 {company:'0',branch:'99999999',locations:{A:'99999999',B:'0'},targets:{A:'99999999',B:'2'}},
])test(`actual count rejects excessive final aggregate and rolls all persistence back ${JSON.stringify(options)}`,async()=>{
 const f=fixture(options),before=structuredClone(f.state)
 await assert.rejects(count(f),e=>e.status===400);assert.deepEqual(f.state,before)
})
test('ordinary non-count stock delta still rejects overflow before any physical write',async()=>{
 const f=fixture({company:'99999999',branch:'99999999'}),before=structuredClone(f.state)
 await assert.rejects(f.transaction(tx=>require('../src/services/bomStock').restoreStockMap(tx,new Map([['p','2']]),'branch',{locationId:'B',reason:'PURCHASE'})),e=>e.status===400)
 assert.deepEqual(f.state,before)
})
test('validated count net cannot bypass a per-location maximum; all movements roll back',async()=>{
 const f=fixture({company:'2',branch:'2',locations:{A:'2',B:'99999999',C:'-99999999'},targets:{A:'0',B:'100000001'}}),before=structuredClone(f.state)
 await assert.rejects(count(f),e=>e.status===400);assert.deepEqual(f.state,before)
})
