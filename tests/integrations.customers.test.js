const test=require('node:test'),assert=require('node:assert/strict')
const {COMPANY,OWNER}=require('./helpers/integrationsDb')
const ctx={companyId:COMPANY,integrationId:OWNER,customerPolicy:'CREATE_IF_MISSING',customerPaymentTermId:1,scopes:['customers.create']}
const person={externalId:'web-1',entityKind:'PERSON',name:'Ana',taxId:'123-K'}
function fixture(rows=[]){
 const links=[],created=[]
 const db={$executeRaw:async()=>0,paymentTerm:{findFirst:async({where})=>where.id===1&&where.company_id===COMPANY?{id:1}:null},
 $queryRaw:async(_sql,companyId,taxId)=>rows.filter(r=>r.company_id===companyId&&r.party_type==='CUSTOMER'&&r.tax_id?.trim().toUpperCase()===taxId).slice(0,2),
 integrationCustomerReference:{findUnique:async({where})=>links.find(l=>Object.entries(where.company_id_integration_id_external_id).every(([k,v])=>l[k]===v)),create:async({data})=>{links.push(data);return data}},
 supplier:{findFirst:async({where})=>rows.find(r=>Object.entries(where).every(([k,v])=>r[k]===v)),findMany:async({where})=>rows.filter(r=>r.company_id===where.company_id&&r.party_type===where.party_type&&r.tax_id?.trim().toUpperCase()===where.tax_id.equals).slice(0,2),create:async({data})=>{const r={id:OWNER,...data};rows.push(r);created.push(r);return r}}}
 return{db,links,created}
}
const resolve=(...a)=>require('../src/modules/integrations/customers').resolveDraftCustomer(...a)
test('registered customer is scoped, eligible and never written',async()=>{
 const row={id:OWNER,company_id:COMPANY,party_type:'CUSTOMER',estado:1,deleted:false,name:'Ana',tax_id:'123-K'}
 const f=fixture([row]);assert.deepEqual(await resolve(f.db,ctx,{customerId:OWNER}),{id:OWNER,name:'Ana',taxId:'123-K',created:false});assert.equal(f.links.length,0)
 for(const change of [{company_id:'foreign'},{party_type:'SUPPLIER'},{estado:0},{deleted:true}])await assert.rejects(()=>resolve(fixture([{...row,...change}]).db,ctx,{customerId:OWNER}),{status:404})
})
test('missing clients obey policy and current creation scope and tenant term',async()=>{
 for(const change of [{customerPolicy:'EXISTING_ONLY'},{scopes:[]},{customerPaymentTermId:2}])await assert.rejects(()=>resolve(fixture().db,{...ctx,...change},{customer:person}),{status:403})
 const f=fixture(),out=await resolve(f.db,ctx,{customer:person});assert.equal(out.created,true);assert.equal(f.links.length,1)
 assert.equal(f.created[0].party_type,'CUSTOMER');assert.equal(f.created[0].default_price_tier,'LIST');assert.equal(f.created[0].credit_limit,'0')
 assert.deepEqual(f.created[0].supplier_payment_terms.create,[{payment_term_id:1,is_default:true,sort_order:0}])
})
test('duplicate or inactive tax identities require review, never expose candidates',async()=>{
 const row={id:OWNER,company_id:COMPANY,party_type:'CUSTOMER',estado:1,deleted:false,name:'Secret',tax_id:'123-K',entity_kind:'PERSON'}
 for(const rows of [[row,row],[{...row,estado:0}],[{...row,deleted:true}]])await assert.rejects(()=>resolve(fixture(rows).db,ctx,{customer:person}),{status:409,integrationCode:'CUSTOMER_REVIEW_REQUIRED'})
 const f=fixture([row]);assert.equal((await resolve(f.db,ctx,{customer:person})).created,false);assert.equal(f.created.length,0)
 await assert.rejects(()=>resolve(f.db,ctx,{customer:{...person,taxId:'other'}}),{status:409})
})
test('generic identifiers and shared names/email never merge customers',async()=>{
 for(const taxId of ['CF',' c/f ','N/A','CONSUMIDOR FINAL','XAXX010101000','XEXX010101000','']){
  const f=fixture([{id:'old',company_id:COMPANY,party_type:'CUSTOMER',estado:1,deleted:false,name:'Ana',tax_id:taxId}])
  assert.equal((await resolve(f.db,ctx,{customer:{...person,taxId}})).created,true)
 }
})
