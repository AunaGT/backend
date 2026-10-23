const {randomUUID}=require('node:crypto'),{Prisma}=require('@prisma/client')
function manualHarness(){
 const scope={companyId:randomUUID(),branchId:randomUUID(),userId:randomUUID(),permissions:['sales.create','sales.view_detail','sales.cancel'],isAdmin:false}
 const product={id:randomUUID(),company_id:scope.companyId,name:'Servicio de prueba',kind:'SERVICE',service_unit_label:'Hora',quantity_decimals:2,price:'10.25',cost:0,available_for_sale:true,deleted:false}
 const customer={id:randomUUID(),company_id:scope.companyId,party_type:'CUSTOMER',estado:1,deleted:false,name:'Cliente',credit_limit:null,supplier_payment_terms:[],customer_price_rules:[]}
 const state={sales:[],items:[],history:[],effects:[]},settings={inventory_units_enabled:'false',inventory_services_enabled:'true',sales_allow_credit:'true'}
 const statuses=[{id:1,name:'Borrador'},{id:2,name:'Completada'},{id:3,name:'Cancelada'}]
 const match=(r,w={})=>Object.entries(w).every(([k,v])=>k==='branch'?v.company_id===scope.companyId:k==='AND'?v.every(x=>match(r,x)):k==='status'?match(statuses.find(x=>x.id===r.status_id),v):v&&typeof v==='object'?(v.in?v.in.includes(r[k]):v.not!==undefined?r[k]!==v.not:true):r[k]===v)
 const view=r=>r&&({...r,status:statuses.find(x=>x.id===r.status_id),sale_items:state.items.filter(x=>x.sale_id===r.id).map(x=>({...x,product})),paymentEntries:[],sale_dtes:[]})
 const db={
  branch:{findFirst:async({where})=>where.id===scope.branchId&&where.company_id===scope.companyId?{id:scope.branchId,code:'B',seq:1}:null},
  systemSetting:{findUnique:async({where})=>({key:where.company_id_key.key,value:settings[where.company_id_key.key]}),findMany:async()=>[{key:'timezone',value:'America/Guatemala'}]},
  supplier:{findFirst:async({where})=>match(customer,where)?customer:null},product:{findMany:async({where})=>match(product,where)?[product]:[],findFirst:async({where})=>match(product,where)?product:null},
  saleStatus:{findUnique:async({where})=>statuses.find(s=>match(s,where)),findFirst:async({where})=>statuses.find(s=>match(s,where))},
  sale:{findFirst:async({where})=>view(state.sales.find(s=>match(s,where))),findMany:async()=>[],create:async({data})=>{const row={id:randomUUID(),version:1,...data};state.sales.push(row);return view(row)},update:async({where,data})=>{const r=state.sales.find(s=>match(s,where));if(!r)throw Error('Missing sale');Object.assign(r,Object.fromEntries(Object.entries(data).map(([k,v])=>[k,v?.increment?r[k]+v.increment:v])));return view(r)}},
  saleItem:{createMany:async({data})=>{for(const r of data)state.items.push({id:state.items.length+1,...r})},deleteMany:async({where})=>{state.items=state.items.filter(r=>!match(r,where))},update:async({where,data})=>Object.assign(state.items.find(l=>l.id===where.id),data)},
  saleHistory:{findFirst:async({where})=>state.history.find(h=>match(h,where))||null,create:async({data})=>{state.history.push(data);return data}},
  companyPaymentMethod:{findFirst:async()=>({enabled:true,payment_method:{id:1,is_credit:true,company_id:null}})},customerPayment:{findMany:async()=>[]},
  $executeRaw:async()=>1,$queryRaw:async()=>[],
 }
 let queue=Promise.resolve();db.$transaction=run=>{const result=queue.then(async()=>{const before=structuredClone(state);try{return await run(db)}catch(e){Object.assign(state,before);throw e}});queue=result.catch(()=>{});return result}
 const input=()=>({expectedVersion:0,idempotencyKey:randomUUID(),customerId:customer.id,customerName:'',customerNit:'',items:[{product_id:product.id,qty:'1.25',expected_unit_price:'10.25'}]})
 const mocks={
  [require.resolve('../../src/modules/sales/application')]:{insertSaleRecord:require('../../src/modules/sales/application').insertSaleRecord,moveSaleStock:async()=>state.effects.push('stock')},
  [require.resolve('../../src/services/stockAvailability')]:{assertLinesAvailable:async()=>state.effects.push('availability')},
  [require.resolve('../../src/services/accounting/postingEngine')]:{postSaleInTransaction:async()=>state.effects.push('accounting')},
  [require.resolve('../../src/services/referenceGenerator')]:{nextDocumentReference:async()=>`V-B-${state.sales.length+1}`},
 }
 return{db,scope,state,settings,product,customer,input,mocks}
}
module.exports={manualHarness}
