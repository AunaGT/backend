const assert=require('node:assert/strict')
const COMPANY='11111111-1111-4111-8111-111111111111',USER='22222222-2222-4222-8222-222222222222',DRAFT='33333333-3333-4333-8333-333333333333',PROMO='44444444-4444-4444-8444-444444444444'
function createCouponApiHarness(){
  let rows=[],saved={id:PROMO,company_id:COMPANY,type:{name:'FIXED_AMOUNT'},deleted:false,active:true,start_date:new Date(),applies_to_all:true,applicable_products:[],applicable_categories:[]},lastWrite,storageError=false,beforeRemove
  const calls=[]
  const matches=(r,w={})=>Object.entries(w).every(([k,v])=>k==='OR'?v.some(x=>matches(r,x)):k==='AND'?v.every(x=>matches(r,x)):v && typeof v==='object' && !(v instanceof Date)? ('in' in v?v.in.includes(r[k]):'notIn' in v?!v.notIn.includes(r[k]):'lte' in v?r[k] && r[k]<=v.lte:'lt' in v?r[k] && r[k]<v.lt:false):r[k]===v)
  const model={findMany:async({where,take}={})=>rows.filter(r=>matches(r,where)).slice(0,take),findFirst:async({where})=>rows.find(r=>matches(r,where)),count:async({where})=>rows.filter(r=>matches(r,where)).length,create:async({data})=>{rows.push(data);return data},update:async({where,data})=>{const row=rows.find(r=>matches(r,where));assert.ok(row);Object.assign(row,data);return row},updateMany:async({where,data})=>{let count=0;for(const row of rows)if(matches(row,where)){Object.assign(row,data);count++}return{count}},deleteMany:async({where})=>{rows=rows.filter(r=>!matches(r,where));return{count:1}}}
  const prisma={promotionCouponAsset:model,promotion:{findFirst:async({where})=>matches(saved,where)?saved:null,findUnique:async()=>saved,update:async({data})=>{lastWrite=data;saved={...saved,...data};return saved}},$executeRaw:async()=>0,$queryRaw:async()=>[],promotionProduct:{deleteMany:async()=>{}},promotionCategory:{deleteMany:async()=>{}}}
  let chain=Promise.resolve()
  prisma.$transaction=async fn=>{let release;const previous=chain;chain=new Promise(r=>release=r);await previous;const oldRows=structuredClone(rows),oldSaved=structuredClone(saved);try{return await fn(prisma)}catch(e){rows=oldRows;saved=oldSaved;throw e}finally{release()}}
  const storage={upload:async(path,buffer)=>{calls.push({op:'upload',path,buffer});return storageError?{error:Error('offline')}:{data:{path}}},createSignedUrls:async paths=>({data:paths.map(path=>({path,signedUrl:'https://qa.test/'+path}))}),remove:async paths=>{if(beforeRemove)await beforeRemove();calls.push({op:'remove',paths});return storageError?{error:Error('offline')}:{} }}
  const originals=[]
  function mock(path,exports){const id=require.resolve(path);originals.push([id,require.cache[id]]);require.cache[id]={id,filename:id,loaded:true,exports}}
  mock('../../src/models/prisma',{prisma,prismaTransaction:prisma})
  mock('../../src/services/supabaseStorage',{assertSupabase:()=>({storage:{from:bucket=>{assert.equal(bucket,'promotion-coupons');return storage}}})})
  for(const path of ['../../src/modules/promotions/couponAssets','../../src/modules/promotions/controller'])delete require.cache[require.resolve(path)]
  const assets=require('../../src/modules/promotions/couponAssets'),controller=require('../../src/modules/promotions/controller')
  const restore=()=>{for(const[id,old]of originals)if(old)require.cache[id]=old;else delete require.cache[id]}
  let error,response
  return{assets,controller,prisma,calls,storage,ctx:{companyId:COMPANY,userId:USER,draftId:DRAFT},req:body=>({body,params:{id:PROMO},query:{},companyId:COMPANY,user:{id:USER}}),res:{status(){return this},json(value){response=value}},next:e=>{error=e},getError:()=>error,getResponse:()=>response,lastWrite:()=>lastWrite,savedPromotion:()=>saved,setStorageError:value=>storageError=value,setBeforeRemove:fn=>beforeRemove=fn,rows:()=>rows,restore}
}
module.exports={createCouponApiHarness,COMPANY,USER,DRAFT,PROMO}
