const {randomUUID}=require('node:crypto')
const ids={company:'10000000-0000-4000-8000-000000000001',branch:'10000000-0000-4000-8000-000000000002',actor:'10000000-0000-4000-8000-000000000003',register:'10000000-0000-4000-8000-000000000004'}
function matches(row,where={}) {return Object.entries(where).every(([k,v])=>k==='OR'?v.some(w=>matches(row,w)):k==='NOT'?!matches(row,v):v&&typeof v==='object'?('in'in v?v.in.includes(row[k]):'not'in v?row[k]!==v.not:matches(row[k]||{},v)):row[k]===v)}
function harness(){
  let tables={hardwareWorkstation:[],hardwareDevice:[],hardwareAssignment:[],hardwareTestRun:[],hardwareAuditEvent:[],cashRegister:[{id:ids.register,branch_id:ids.branch,name:'Caja 1',active:true}],cashRegisterSession:[],branch:[{id:ids.branch,company_id:ids.company,active:true}]},queue=Promise.resolve()
  for(const name of ['sale','company','systemSetting','documentSnapshot','documentArtifact','documentTemplateDefault','documentTemplateAsset','barcodePrintPreparation','companyModule','hardwarePrintJob','hardwarePrintEvent','hardwareDrawerPolicy','hardwareDrawerIntent','hardwareDrawerAttempt','customerPayment','returnSettlement'])tables[name]=[]
  tables.company.push({id:ids.company,name:'Empresa de prueba'})
  tables.companyModule.push({company_id:ids.company,module_code:'inventory',status:'ACTIVE'})
  tables.cashRegister[0].branch={company_id:ids.company}
  const db={$queryRaw:async(sql,...values)=>{
    if(!String(sql).includes('FROM sales s'))return[]
    const [id,branch_id,company_id]=values
    const sale=tables.sale.find(s=>s.id===id&&s.branch_id===branch_id&&s.branch?.company_id===company_id)
    if(!sale)return[]
    return[{...structuredClone(sale),_ticket_settings:Object.fromEntries(tables.systemSetting.filter(s=>s.company_id===company_id).map(s=>[s.key,s.value])),_ticket_company_name:tables.company.find(c=>c.id===company_id)?.name}]
  }, $executeRaw:async()=>0}
  for(const name of Object.keys(tables))db[name]={
    findMany:async({where,skip=0,take,orderBy}={})=>{let rows=tables[name].filter(r=>matches(r,where));if(orderBy)rows=rows.toSorted((a,b)=>String(a.created_at||a.name||a.id).localeCompare(String(b.created_at||b.name||b.id)));return structuredClone(rows.slice(skip,take?skip+take:undefined))},
    findFirst:async({where})=>structuredClone(tables[name].find(r=>matches(r,where))||null),
    findUnique:async({where})=>structuredClone(tables[name].find(r=>matches(r,where.company_id_actor_id_request_key||where))||null),
    count:async({where}={})=>tables[name].filter(r=>matches(r,where)).length,
    create:async({data})=>{const row={id:randomUUID(),version:1,created_at:new Date(),...structuredClone(data)};tables[name].push(row);return structuredClone(row)},
    createMany:async({data})=>{tables[name].push(...data.map(row=>({id:randomUUID(),...structuredClone(row)})));return{count:data.length}},
    updateMany:async({where,data})=>{let count=0;for(const row of tables[name].filter(r=>matches(r,where))){for(const[k,v]of Object.entries(data))row[k]=v&&typeof v==='object'&&'increment'in v?row[k]+v.increment:v;count++}return{count}},
    deleteMany:async({where})=>{const old=tables[name].length;tables[name]=tables[name].filter(r=>!matches(r,where));return{count:old-tables[name].length}},
  }
  db.$transaction=(run)=>{const result=queue.then(async()=>{const backup=structuredClone(tables);try{return await run(db)}catch(e){tables=backup;throw e}});queue=result.catch(()=>{});return result}
  return{db,rows:name=>tables[name],scope:{companyId:ids.company,branchId:ids.branch,branchIds:[ids.branch],actorId:ids.actor,isConsolidated:false,permissions:['hardware.view','hardware.manage','hardware.test_print','hardware.test_drawer']}}
}
const station=(code='PC1')=>({code,name:code,state:'ACTIVE',cashRegisterId:ids.register})
const device=(kind='SCANNER',profile=kind==='SCANNER'?{scannerSuffix:'ENTER'}:{})=>({code:randomUUID().slice(0,8),name:kind,kind,state:'ACTIVE',connection:kind==='SCANNER'?'HID':kind==='CASH_DRAWER'?'PRINTER_PORT':'SYSTEM_PRINTER',profile})
const receiptSale=()=>({branch_id:ids.branch,branch:{company_id:ids.company,name:'Principal',company:{name:'Empresa de prueba'}},created_by:ids.actor,date:new Date('2026-10-22'),status:{name:'Completada'},subtotal:'20.00',discount_total:null,total:'20.00',sale_items:[{item_name:'Café',unit_label:'unidad',unit_metadata_version:1,qty:'2',price:'10.00',net_total:'20.00'}]})
module.exports={harness,ids,station,device,receiptSale}
