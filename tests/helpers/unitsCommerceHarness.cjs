const assert=require('node:assert/strict')
const {Prisma}=require('@prisma/client')
const D=v=>new Prisma.Decimal(v??0)
const plain=value=>Prisma.Decimal.isDecimal(value)?value.toFixed():value instanceof Date?value:Array.isArray(value)?value.map(plain):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,plain(v)])):value

function commerceHarness({products,stock,locations,lots=[],units=[],presentations=[]}){
  const state={products:structuredClone(products),stock:structuredClone(stock),locations:structuredClone(locations),lots:structuredClone(lots),movements:[],sales:[],saleItems:[],returns:[],returnItems:[],settlements:[],credits:[],documents:[],documentLines:[],deliveries:[],deliveryLines:[],reservations:[]}
  const product=id=>state.products.find(p=>p.id===id)&&{...structuredClone(state.products.find(p=>p.id===id)),stock:state.stock[id]??'0',min_stock:0,branch_stocks:[{stock:state.stock[id]??'0'}]}
  const match=(row,where={})=>Object.entries(where).every(([key,value])=>{
    if(value===undefined||['company','branch','warehouse','document','return','delivery','OR'].includes(key))return true
    if(key==='AND')return value.every(w=>match(row,w))
    if(value&&typeof value==='object'&&!Array.isArray(value)){if(value.in)return value.in.includes(row[key]);if(value.gt!=null)return D(row[key]).gt(value.gt);if(value.lt!=null)return D(row[key]).lt(value.lt);if(value.not!=null)return row[key]!==value.not;return true}
    return row[key]===value
  })
  const change=(row,data)=>{for(const [key,value]of Object.entries(plain(data))){row[key]=value&&typeof value==='object'&&value.increment!=null?D(row[key]).add(value.increment).toFixed():value&&typeof value==='object'&&value.decrement!=null?D(row[key]).sub(value.decrement).toFixed():value}return row}
  const saleView=row=>row&&{...row,status:{name:row.status_id===2?'Cancelada':'Completada'},sale_items:state.saleItems.filter(item=>item.sale_id===row.id),sale_dtes:[],paymentEntries:[],payment_method:{id:1,is_credit:false,name:'Transferencia'},cashRegisterSession:null,orderLink:null}
  const returnView=row=>row&&{...row,status:{name:row.status_id===3?'Completada':'Aprobada'},return_items:state.returnItems.filter(item=>item.return_id===row.id),replacement_items:[],sale:saleView(state.sales.find(s=>s.id===row.sale_id))}
  const documentView=row=>row&&{...row,lines:state.documentLines.filter(line=>line.document_id===row.id)}
  const tx={
    systemSetting:{findUnique:async({where})=>({key:where.company_id_key.key,value:where.company_id_key.key==='inventory_units_enabled'?'true':null}),findMany:async()=>[]},
    product:{findMany:async({where})=>state.products.filter(p=>match(p,where)).map(p=>product(p.id)),findFirst:async({where})=>state.products.find(p=>match(p,where))&&product(where.id),findUnique:async({where})=>product(where.id)},
    measureUnit:{findFirst:async({where})=>units.find(u=>u.id===where.id)},productPresentation:{findFirst:async({where})=>presentations.find(p=>match(p,where))},
    stockLocation:{findFirst:async({where})=>({id:where.id,pickable:true}),findMany:async({where})=>where.id.in.map(id=>({id,pickable:true}))},
    productStock:{findMany:async({where})=>where.product_id.in.map(product_id=>({product_id,stock:state.stock[product_id]??'0'}))},
    productStockLocation:{findMany:async({where})=>Object.entries(state.locations).map(([key,stock])=>{const [product_id,location_id]=key.split('|');return{product_id,location_id,stock}}).filter(row=>match(row,where))},
    stockReservation:{findMany:async({where})=>state.reservations.filter(row=>match(row,where)).map(row=>structuredClone(row)),createMany:async({data})=>{state.reservations.push(...plain(data).map((row,i)=>({id:`R${state.reservations.length+i}`,...row})))},update:async({where,data})=>change(state.reservations.find(row=>row.id===where.id),data),updateMany:async({where,data})=>{state.reservations.filter(row=>match(row,where)).forEach(row=>change(row,data))}},
    stockMovement:{findMany:async({where})=>state.movements.filter(row=>match(row,where)),createMany:async({data})=>{state.movements.push(...plain(data).map((row,i)=>({id:`M${state.movements.length+i}`,created_at:new Date(),...row}))) }},
    productLot:{findMany:async({where})=>state.lots.filter(row=>match(row,where)).map(row=>({...row})),update:async({where,data})=>change(state.lots.find(row=>row.id===where.id),data),create:async({data})=>{const row={id:`LOT${state.lots.length}`,...plain(data)};state.lots.push(row);return row}},
    sale:{findFirst:async({where})=>saleView(state.sales.find(row=>match(row,where))),create:async({data})=>{const {sale_items,...header}=plain(data),row={id:`V${state.sales.length}`,version:1,...header};state.sales.push(row);if(sale_items)state.saleItems.push(...sale_items.create.map((line,i)=>({id:state.saleItems.length+i+1,sale_id:row.id,...line})));return saleView(row)},update:async({where,data})=>saleView(change(state.sales.find(row=>row.id===where.id),data))},
    saleItem:{findMany:async({where})=>state.saleItems.filter(row=>match(row,where)),createMany:async({data})=>{state.saleItems.push(...plain(data).map((row,i)=>({id:state.saleItems.length+i+1,...row})))},update:async({where,data})=>change(state.saleItems.find(row=>row.id===where.id),data)},
    return:{findFirst:async({where})=>returnView(state.returns.find(row=>match(row,where))),update:async({where,data})=>returnView(change(state.returns.find(row=>row.id===where.id),data))},
    returnItem:{findMany:async({where})=>state.returnItems.filter(row=>match(row,where)),update:async({where,data})=>change(state.returnItems.find(row=>row.id===where.id),data)},
    returnSettlement:{findFirst:async({where})=>state.settlements.find(row=>match(row,where)),create:async({data})=>{const row={id:`SET${state.settlements.length}`,...plain(data)};state.settlements.push(row);return row}},
    customerPayment:{create:async({data})=>{state.credits.push(plain(data));return data}},
    commercialDocument:{findUnique:async({where})=>documentView(state.documents.find(row=>match(row,where))),findFirst:async({where})=>documentView(state.documents.find(row=>match(row,where))),create:async({data})=>{const {lines,...header}=plain(data),row={id:`O${state.documents.length}`,...header};state.documents.push(row);state.documentLines.push(...lines.create.map((line,i)=>({id:`OL${state.documentLines.length+i}`,document_id:row.id,...line})));return documentView(row)},update:async({where,data})=>documentView(change(state.documents.find(row=>row.id===where.id),data))},
    commercialDocumentLine:{findMany:async({where})=>state.documentLines.filter(row=>match(row,where)),findUnique:async({where})=>state.documentLines.find(row=>match(row,where)),update:async({where,data})=>change(state.documentLines.find(row=>row.id===where.id),data)},
    orderDelivery:{findUnique:async()=>null,findFirst:async({where})=>{const row=state.deliveries.find(row=>match(row,where));return row&&{...row,lines:state.deliveryLines.filter(line=>line.delivery_id===row.id)}},create:async({data})=>{const {lines,...header}=plain(data),row={id:`D${state.deliveries.length}`,...header};state.deliveries.push(row);const saved=lines.create.map((line,i)=>({id:`DL${state.deliveryLines.length+i}`,delivery_id:row.id,...line}));state.deliveryLines.push(...saved);return{...row,lines:saved}},update:async({where,data})=>change(state.deliveries.find(row=>row.id===where.id),data)},
    orderDeliveryLine:{findMany:async({where})=>state.deliveryLines.filter(row=>match(row,where)),update:async({where,data})=>change(state.deliveryLines.find(row=>row.id===where.id),data)},
    saleStatus:{findFirst:async()=>({id:1}),findUnique:async({where})=>({id:where.id,name:where.id===2?'Cancelada':'Completada'})},returnStatus:{findFirst:async()=>({id:3})},
    status:{findFirst:async()=>null},alertType:{findMany:async()=>[]},alertPriority:{findMany:async()=>[]},
    branch:{findUnique:async()=>({id:'B',code:'A',seq:1})},cashRegister:{findFirst:async()=>({id:'C'})},cashRegisterSession:{findFirst:async()=>({id:'CS',opened_by_id:'U'})},
    companyPaymentMethod:{findFirst:async()=>({enabled:true,payment_method:{id:1,name:'Transferencia',is_credit:false,settlement_kind:'BANK'}})},
    $executeRaw:async()=>1,
    $queryRaw:async(sql,...args)=>{
      const text=String(sql),values=args.flatMap(value=>value?.values||[])
      if(text.includes('SELECT l.id'))return text.includes('LIMIT 1')?[{id:Object.keys(state.locations)[0].split('|')[1]}]:values.filter(id=>Object.keys(state.locations).some(key=>key.endsWith('|'+id))).map(id=>({id}))
      if(text.includes('SELECT psl.product_id'))return Object.entries(state.locations).map(([key,stock])=>{const [product_id,location_id]=key.split('|');return{product_id,location_id,stock}}).filter(row=>D(row.stock).gt(0))
      if(text.includes('FOR UPDATE OF ps'))return values.filter(id=>product(id)).map(id=>({...product(id),deleted:false}))
      if(text.includes('UPDATE product_stock_locations')){const rows=[];for(let i=0;i<values.length;i+=3){const [product_id,location_id,qty]=values.slice(i,i+3),key=`${product_id}|${location_id}`;state.locations[key]=D(state.locations[key]).add(qty).toFixed();rows.push({product_id,location_id,qty,balance:state.locations[key]})}return rows}
      if(text.includes('UPDATE product_stocks')){const rows=[];for(let i=0;i<values.length;i+=2){const [id,qty]=values.slice(i,i+2);state.stock[id]=D(state.stock[id]).add(qty).toFixed();rows.push({id,stock:state.stock[id],min_stock:0})}return rows}
      if(text.includes('commercial_documents')&&text.includes('FOR UPDATE'))return state.documents.filter(row=>args.includes(row.id)||args.includes(row.reference)).map(row=>({id:row.id}))
      if(text.includes('FOR UPDATE'))return []
      assert.fail('Unexpected persistence query '+text)
    },
  }
  tx.$transaction=async run=>{const before=structuredClone(state);try{return await run(tx)}catch(error){Object.assign(state,before);throw error}}
  return {tx,state,product,saleView,returnView}
}
module.exports={commerceHarness}
