const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const target=path.resolve(__dirname,'../src/modules/inventory/posCatalog.js'),api=fs.existsSync(target)?require(target):{}
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,scope={companyId:'A',branchId:'B',user:{permissions:['sales.create']}}
function matches(row,where){return Object.entries(where).every(([key,value])=>{
 if(key==='AND')return value.every(w=>matches(row,w));if(key==='OR')return value.some(w=>matches(row,w))
 if(key==='branch_stocks')return row.branch_stocks.some(r=>matches(r,value.some))
 if(key==='category')return matches(row.category,value)
 if(value&&typeof value==='object'){if('in'in value)return value.in.includes(row[key]);if('not'in value)return row[key]!==value.not;if('contains'in value)return String(row[key]??'').toLowerCase().includes(value.contains.toLowerCase());if('equals'in value)return String(row[key]??'').toLowerCase()===value.equals.toLowerCase()}
 return row[key]===value
})}
function fixture(){
 const p=(n,extra={})=>({id:id(n),name:'Café',company_id:'A',deleted:false,available_for_sale:true,kind:'STANDARD',barcode:'00123'+n,price:'5',stock:'999',min_stock:'0',category_id:1,category:{id:1,name:'Bebidas'},branch_stocks:[{branch_id:'B',stock:'0',min_stock:'2'}],cost:'SECRET',...extra})
 const rows=[p(1),p(2,{base_unit_id:id(20),unit_metadata_version:2,quantity_decimals:6,unit_revision:1,stock:'999',branch_stocks:[{branch_id:'B',stock:'1.25',min_stock:'0.1'}]}),p(3,{name:'Consulta',kind:'SERVICE',category_id:2,category:{id:2,name:'Servicios'},branch_stocks:[]}),p(4,{company_id:'OTHER'}),p(5,{deleted:true}),p(6,{available_for_sale:false}),p(7,{branch_stocks:[{branch_id:'OTHER',stock:'20'}]})]
 const reads=[];let enabled=true
 const db={product:{count:async({where})=>rows.filter(row=>matches(row,where)).length,findMany:async args=>{reads.push(args);return rows.filter(row=>matches(row,args.where)).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id)).slice(args.skip??0,(args.skip??0)+args.take)},groupBy:async({where})=>{const counts=new Map();for(const row of rows.filter(r=>matches(r,where)))counts.set(row.category_id,(counts.get(row.category_id)??0)+1);return[...counts].map(([category_id,count])=>({category_id,_count:{_all:count}}))}},productStock:{findMany:async({where})=>rows.filter(r=>where.product_id.in.includes(r.id)).flatMap(r=>r.branch_stocks.filter(b=>b.branch_id===where.branch_id).map(b=>({...b,product_id:r.id})))},productCategory:{findMany:async()=>[{id:1,name:'Bebidas',image_url:'/bebidas.png'},{id:2,name:'Servicios',image_url:'/servicios.png'}]},systemSetting:{findUnique:async()=>({value:String(enabled)})},measureUnit:{findMany:async()=>[{id:id(20),name:'Kilogramo',code:'KG',label:'kg',factor:'1',quantity_decimals:6}]},productPresentation:{findMany:async()=>[]},productBarcode:{findMany:async()=>[]}}
 return{db,rows,reads,disable:()=>enabled=false}
}
test('POS catalog filters before stable pagination and overlays exact branch stock without supplier/cost detail',async()=>{
 assert.equal(typeof api.listPosCatalog,'function');const f=fixture(),r=await api.listPosCatalog(f.db,scope,{page:'2',pageSize:'1'})
 assert.equal(r.totalItems,2);assert.equal(r.page,2);assert.equal(r.items[0].id,id(2));assert.equal(String(r.items[0].stock),'1.25');assert.equal(r.items[0].base_unit.label,'kg');assert.equal(r.items[0].cost,undefined)
 assert.deepEqual(f.reads[0].orderBy,[{name:'asc'},{id:'asc'}]);assert.equal(f.reads[0].take,1);assert.equal(f.reads[0].select.supplier,undefined)
 assert.equal((await api.listPosCatalog(f.db,scope,{page:'999',pageSize:'1'})).page,2)
 const search=await api.listPosCatalog(f.db,scope,{search:'Café',category:'Servicios'});assert.equal(search.totalItems,2)
})
test('POS categories count the full eligible universe with images and services only when enabled',async()=>{
 assert.equal(typeof api.listPosCategories,'function');const f=fixture(),r=await api.listPosCategories(f.db,scope,{catalog_type:'all'})
 assert.deepEqual(r,{items:[{name:'Bebidas',count:2,image_url:'/bebidas.png'},{name:'Servicios',count:1,image_url:'/servicios.png'}],totalItems:3});assert.equal(f.reads.length,0)
 f.disable();await assert.rejects(api.listPosCatalog(f.db,scope,{catalog_type:'all'}),{status:403})
})
test('all POS product readers preserve authoritative unit metadata versions for their consumers',async()=>{
 for(const version of [1,2]){
  const f=fixture();f.rows[1].unit_metadata_version=version
  const page=await api.listPosCatalog(f.db,scope,{page:'2',pageSize:'1'}),batch=await api.posCatalogItems(f.db,scope,{ids:[id(2)]}),code=await api.resolvePosCode(f.db,scope,{code:'001232'})
  for(const item of [page.items[0],batch.items[0],code.item])assert.equal(item.unit_metadata_version,version)
  for(const query of f.reads)assert.equal(query.select.unit_metadata_version,true)
 }
})
test('POS catalog rejects malformed filters, denied scope and unsafe ID batches before reads',async()=>{
 assert.equal(typeof api.posCatalogItems,'function');const f=fixture()
 for(const query of [{page:'0'},{page:'NaN'},{pageSize:'101'},{search:'a'.repeat(101)},{category:['A']},{catalog_type:'services'}])await assert.rejects(api.listPosCatalog(f.db,scope,query),{status:400})
 for(const denied of [{...scope,branchId:null},{...scope,branchId:'all'},{...scope,companyId:''},{...scope,user:{permissions:[]}}])await assert.rejects(api.listPosCatalog(f.db,denied,{}))
 for(const raw of [{ids:[]},{ids:Array.from({length:201},(_,i)=>id(i))},{ids:['invalid']},{ids:[id(1)],factor:'100'}])await assert.rejects(api.posCatalogItems(f.db,scope,raw),{status:400})
 assert.equal(f.reads.length,0)
 const result=await api.posCatalogItems(f.db,scope,{ids:[id(1),id(4)],catalog_type:'goods'});assert.deepEqual(result.items.map(p=>p.id),[id(1)]);assert.deepEqual(result.missingIds,[id(4)])
 const many=await api.posCatalogItems(f.db,scope,{ids:Array.from({length:200},(_,i)=>id(i+1)),catalog_type:'goods'});assert.equal(many.items.length,2);assert.equal(many.missingIds.length,198)
})
test('legacy barcode resolution is exact, independent of page and category and rejects ambiguous codes',async()=>{
 assert.equal(typeof api.resolvePosCode,'function');const f=fixture();assert.equal((await api.resolvePosCode(f.db,scope,{code:'001232'})).item.id,id(2));assert.equal(f.reads[0].take,2)
 assert.equal((await api.resolvePosCode(f.db,scope,{code:'00123'})).item,null)
 f.rows[1].barcode=f.rows[0].barcode;await assert.rejects(api.resolvePosCode(f.db,scope,{code:f.rows[0].barcode}),{status:409})
})
test('mounted POS routes accept a cashier without inventory permission and reject revoked permission or consolidated writes',async()=>{
 const {withMocks}=require('./helpers/reportHarness.cjs'),express=require('express'),{crearToken}=require('../src/services/jwt'),f=fixture(),role={name:'cajero',permissions:[{permission:{code:'sales.create'}}]}
 await withMocks({[require.resolve('../src/models/prisma')]:{prisma:f.db,prismaTransaction:f.db}},require.resolve('../src/modules/inventory/products.routes'),async router=>{
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.companyId=req.headers['x-company-id']??'A';req.branchId=req.headers['x-branch-id']==='all'?null:'B';const effective=req.headers['x-denied']?{name:'lector',permissions:[]}:role;req.sessionUser={id:'U',role:effective,user_companies:[{company_id:'A',status:'ACTIVE',company:{active:true},role:effective}]};next()});app.use('/products',router);app.use((e,req,res,next)=>res.status(e.status??500).json({message:e.message}))
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const url=`http://127.0.0.1:${server.address().port}`,headers={Authorization:'Bearer '+crearToken({id:'U',auth_version:0})}
  try{
   const response=await fetch(url+'/products/pos-catalog?pageSize=1',{headers});assert.equal(response.status,200);assert.equal((await response.json()).items.length,1)
   assert.equal((await fetch(url+'/products/pos-catalog/categories',{headers})).status,200)
   assert.equal((await fetch(url+'/products/pos-catalog/resolve-code?code=001231',{headers})).status,200)
   assert.equal((await fetch(url+'/products/pos-catalog',{headers:{...headers,'x-denied':'1'}})).status,403)
   assert.equal((await fetch(url+'/products/pos-catalog',{headers:{...headers,'x-company-id':'OTHER'}})).status,403)
   assert.equal((await fetch(url+'/products/pos-catalog/items',{method:'POST',headers:{...headers,'Content-Type':'application/json','x-branch-id':'all'},body:JSON.stringify({ids:[id(1)]})})).status,400)
  }finally{await new Promise(resolve=>server.close(resolve))}
 })
})
