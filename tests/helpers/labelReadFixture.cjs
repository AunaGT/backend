const assert=require('node:assert/strict')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function matches(row,where={}){return Object.entries(where).every(([key,value])=>{
 if(key==='AND')return value.every(w=>matches(row,w));if(key==='OR')return value.some(w=>matches(row,w))
 if(value&&typeof value==='object'&&!Array.isArray(value)){
  if('in'in value)return value.in.includes(row[key]);if('not'in value)return row[key]!==value.not
  if('gt'in value)return row[key]>value.gt
  if('contains'in value)return String(row[key]??'').toLowerCase().includes(value.contains.toLowerCase())
  if('equals'in value)return value.mode==='insensitive'?String(row[key]).toLowerCase()===String(value.equals).toLowerCase():row[key]===value.equals
  if('some'in value)return(row[key]??[]).some(r=>matches(r,value.some))
  return !!row[key]&&matches(row[key],value)
 }
 return row[key]===value
})}
const project=(row,select)=>row==null?null:select?Object.fromEntries(Object.entries(select).filter(([,v])=>v).map(([key])=>[key,structuredClone(row[key])])):structuredClone(row)
function labelFixture(count=1,packs=1){
 const companyId=id(900001),branchId=id(900002),baseId=id(900003),scope={companyId,branchId,branchIds:[branchId],userId:id(900004),isAdmin:false,permissions:['products.view','products.export','products.edit']},calls=[]
 const products=Array.from({length:count},(_,i)=>({id:id(i+1),company_id:companyId,name:'Producto '+String(i+1).padStart(3,'0'),kind:'STANDARD',deleted:false,available_for_sale:true,barcode:'001'+i,price:'5.25',price_wholesale:'4',price_promotion:'3',promotion_valid_until:null,brand:null,size:null,base_unit_id:baseId,unit_metadata_version:2,unit_revision:1,quantity_decimals:3,cost:'PRIVATE',stock:'0',category:{name:'Alimentos'},branch_stocks:[{branch_id:branchId}]}))
 const presentations=products.flatMap((p,i)=>Array.from({length:packs},(_,j)=>({id:id(1000+i*100+j),company_id:companyId,product_id:p.id,name:'Caja '+j,label:'caja'+j,factor:'6',version:1,quantity_decimals:0,active:true,sale_enabled:true,purchase_enabled:true,price:null,price_wholesale:null,price_promotion:null,promotion_valid_until:null})))
 const bases=[{id:baseId,company_id:companyId,code:'KG',name:'Kilogramo',label:'kg',quantity_decimals:3,factor:'1',active:true}]
 const codes=presentations.map((p,i)=>({id:id(50000+i),company_id:companyId,product_id:p.product_id,presentation_id:p.id,active:true,code:'000'+i}))
 const settings=[{company_id:companyId,key:'inventory_units_enabled',value:'true'}]
 const read=(name,run)=>async args=>{calls.push({name,args});return run(args??{})}
 const model=(rows,name)=>({findMany:read(name+'.findMany',q=>{let result=rows.filter(row=>matches(row,q.where));const order=Array.isArray(q.orderBy)?q.orderBy:q.orderBy?[q.orderBy]:[];result.sort((a,b)=>{for(const rule of order)for(const [key,direction]of Object.entries(rule)){const n=String(a[key]).localeCompare(String(b[key]));if(n)return direction==='desc'?-n:n}return 0});return result.slice(q.skip??0,(q.skip??0)+(q.take??result.length)).map(row=>project(row,q.select))}),findFirst:read(name+'.findFirst',q=>project(rows.find(row=>matches(row,q.where)),q.select)),count:read(name+'.count',q=>rows.filter(row=>matches(row,q.where)).length)})
 const db={product:model(products,'product'),measureUnit:model(bases,'base'),productPresentation:model(presentations,'presentation'),productBarcode:model(codes,'code'),companyModule:model([{company_id:companyId,module_code:'inventory',status:'ACTIVE'}],'module'),branch:model([{id:branchId,company_id:companyId,active:true}],'branch'),systemSetting:{...model(settings,'setting'),findUnique:read('setting.findUnique',q=>project(settings.find(r=>matches(r,q.where.company_id_key)),q.select))}}
 const noWrites=new Proxy(db,{get(target,key){if(key in target)return target[key];assert.fail('Unexpected DB operation '+String(key))}})
 return{db:noWrites,scope,products,presentations,bases,codes,settings,calls,id}
}
function preparationFixture(count=1,packs=1){
 const f=labelFixture(count,packs),{db,calls}=f,snapshots=[],writes=[]
 db.company={findUnique:async()=>{calls.push({name:'company.findUnique'});return{name:'QA'}}}
 db.barcodePrintPreparation={findUnique:async q=>{calls.push({name:'snapshot.findUnique'});return structuredClone(snapshots.find(row=>matches(row,q.where.company_id_actor_id_request_key)))},create:async({data})=>{snapshots.push(structuredClone(data));writes.push('snapshot');return data}}
 db.$executeRaw=async(strings,...values)=>{calls.push({name:'lock.execute',values});return 0}
 db.$queryRaw=async(strings,...values)=>{calls.push({name:'lock.query'});return Array.isArray(strings)&&strings.some(s=>s.includes('btrim'))?f.products.filter(p=>p.company_id===values[0]&&p.barcode?.trim()===values[1]&&p.id!==values[2]).map(p=>({id:p.id})):[]}
 db.product.update=async({where,data})=>{const row=f.products.find(p=>p.id===where.id);assert.ok(row);Object.assign(row,data);writes.push('product');return row}
 db.productBarcode.create=async({data})=>{if(f.codes.some(c=>c.company_id===data.company_id&&c.code===data.code))throw Object.assign(Error('unique'),{code:'P2002'});const row={id:id(70000+f.codes.length),...data};f.codes.push(row);writes.push('code');return row}
 db.productBarcode.update=async({where,data})=>{const row=f.codes.find(p=>p.id===where.id);assert.ok(row);Object.assign(row,data);writes.push('code');return row}
 db.productBarcode.updateMany=async({where,data})=>{for(const row of f.codes.filter(row=>matches(row,where)))Object.assign(row,data);return{count:1}}
 db.$transaction=async run=>{const before=structuredClone({products:f.products,codes:f.codes,snapshots,writes});try{return await run(db)}catch(error){for(const [key,rows]of Object.entries(before)){const target=key==='products'?f.products:key==='codes'?f.codes:key==='snapshots'?snapshots:writes;target.splice(0,target.length,...rows)}throw error}}
 const validation=require('../../src/modules/inventory/barcodeLabels/validation'),crypto=require('node:crypto')
 const input=purpose=>({requestKey:crypto.randomUUID(),scope:{branchId:f.scope.branchId,inBranch:false},items:f.products.flatMap(p=>[{productId:p.id,unit_revision:p.unit_revision,copies:1,expectedBarcode:p.barcode,assignment:{mode:'keep'}},...f.presentations.filter(row=>row.product_id===p.id).map(row=>({productId:p.id,presentation_id:row.id,unit_revision:p.unit_revision,copies:1,expectedBarcode:f.codes.find(c=>c.presentation_id===row.id).code,assignment:{mode:'keep'}}))]),design:purpose==='shelf'?validation.createShelfLabelTemplate():validation.createLabelTemplate(),paper:validation.defaultPaper(),confirmAssignments:false})
 return{...f,snapshots,writes,input}
}
module.exports={labelFixture,preparationFixture,id,matches,project}
