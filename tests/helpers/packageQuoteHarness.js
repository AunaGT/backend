const {randomUUID}=require('node:crypto')
const path=require('node:path')
const {agreementFixture}=require('./packageAgreementFixture')
const {withMocks,jsonResponse}=require('./reportHarness.cjs')
const {id}=require('./packageFixtures')
const copy=value=>JSON.parse(JSON.stringify(value))
async function quoteHarness(run){
  const f=await agreementFixture();let document=null,stockWrites=0
  const find=async({where={}}={})=>{
    if(!document)return null
    if(where.id&&where.id!==document.id||where.doc_type&&where.doc_type!==document.doc_type||where.branch_id&&where.branch_id!==document.branch_id)return null
    return copy({...document,_count:{lines:document.lines.length},branch:{company_id:f.scope.companyId}})
  }
  f.db.commercialDocument={findFirst:find,findUnique:find,create:async({data})=>{
    document=copy({id:id(400),integration_revision:f.revision,documentSales:[],convertedChildren:[],quoted_engagement:null,...data,lines:data.lines.create})
    return find()
  },update:async({data})=>{
    const next=copy(data);if(next.lines)next.lines=next.lines.create
    Object.assign(document,next,{integration_revision:randomUUID()});return find()
  },updateMany:async({data})=>{Object.assign(document,copy(data));return{count:1}}}
  f.db.commercialDocumentLine={findMany:async()=>copy(document?.lines??[]),deleteMany:async()=>{document.lines=[];return{count:1}}}
  const transaction=f.db.$transaction
  f.db.$transaction=async fn=>{const before=document&&copy(document);try{return await transaction(fn)}catch(e){document=before;throw e}}
  f.db.$queryRaw=async()=>document?[{id:document.id}]:[]
  f.db.branch.findUnique=async()=>({id:f.scope.branchId,code:'T',seq:1})
  const target=path.resolve(__dirname,'../../src/modules/quotes/controller')
  const mocks={
    [require.resolve('../../src/models/prisma')]:{prisma:f.db,prismaTransaction:f.db},
    [require.resolve('../../src/services/referenceGenerator')]:{nextDocumentReference:async()=> 'Q-T-1'},
    [require.resolve('../../src/services/commercialPayment')]:{documentPaymentTerms:async()=>({payment_condition:'CASH',credit_days:null})},
    [require.resolve('../../src/services/commercialDocumentSettings')]:{defaultQuoteValidUntil:async()=>null},
    [require.resolve('../../src/services/customerPagesPublic')]:{resolvePublicPortal:async()=>null},
    [require.resolve('../../src/services/stockAvailability')]:{assertLinesAvailable:async()=>{},reserveForDocument:async()=>{stockWrites++},releaseByDocument:async()=>{stockWrites++}},
    [require.resolve('../../src/modules/quotes/access')]:{getCompanyModuleBlock:async()=>null},
  }
  const req=body=>({companyId:f.scope.companyId,branchId:f.scope.branchId,userBranchIds:f.scope.branchIds,user:{sub:f.scope.actorId,permissions:f.scope.permissions},params:{id:id(400),token:'token'},body})
  await withMocks(mocks,target,async controller=>run({...f,controller,document:()=>document,setDocument:value=>{document=value},stockWrites:()=>stockWrites,req,
    invoke:async(method,body)=>{const res=jsonResponse();let error;await controller[method](req(body),res,e=>{error=e});return{res,error}}}))
}
module.exports={quoteHarness}
