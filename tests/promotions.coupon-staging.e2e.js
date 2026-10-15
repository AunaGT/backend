const{test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),sharp=require('sharp')
require('../src/config/loadEnv')
const{PrismaClient,Prisma}=require('@prisma/client'),{couponStagingUrl}=require('../scripts/coupon-staging')
const{loadReportModule}=require('../../deposito-frontend/tests/helpers/loadReportModule.cjs')
test('staging QA image saves/reopens/replaces/restores without touching customer promotions',async()=>{
  const db=new PrismaClient({datasources:{db:{url:couponStagingUrl()}}}),token=randomUUID(),qaAssets=[],qaPromos=[]
  let company,user
  const modulePath=require.resolve('../src/models/prisma'),old=require.cache[modulePath]
  require.cache[modulePath]={id:modulePath,filename:modulePath,loaded:true,exports:{prisma:db,prismaTransaction:db}}
  const assets=require('../src/modules/promotions/couponAssets'),controller=require('../src/modules/promotions/controller'),{assertSupabase}=require('../src/services/supabaseStorage')
  const invoke=async(name,body,id)=>{
    let response,error,status=200
    await controller[name]({body,params:{id},companyId:company.id,user:{id:user.id},query:{}},{status(n){status=n;return this},json(data){response=data}},e=>error=e)
    if(error)throw error;assert.ok(status<400,JSON.stringify(response));return response
  }
  try{
    const type=await db.promotionType.findFirst({where:{name:'PERCENTAGE'}}),role=await db.role.findFirst();assert.ok(type&&role)
    company=await db.company.create({data:{name:'QA Cupones '+token.slice(0,8),code:'CUP-QA-'+token.slice(0,8)}})
    user=await db.user.create({data:{name:'QA Cupones',email:`coupon-${token}@qa.invalid`,password:'!NO_SESSION',role_id:role.id}})
    await db.userCompany.create({data:{user_id:user.id,company_id:company.id}})
    const ctx={companyId:company.id,userId:user.id,draftId:randomUUID()}
    const image=await sharp({create:{width:600,height:432,channels:4,background:'#0c203a'}}).png().toBuffer()
    const dto=await assets.uploadCouponAsset(ctx,{mimetype:'image/png',buffer:image});qaAssets.push(dto.id)
    const design=loadReportModule('../promotions/coupons/couponDesign.ts').createDefaultCouponDesign()
    design.background={kind:'image',assetId:dto.id,fit:'cover',focalX:.25,focalY:.5}
    const promo=await invoke('create',{name:'QA Cupón '+token.slice(0,8),type_id:type.id,discount_percentage:15,applies_to_all:true,applies_to_all_branches:true,active:false,codes:['QA-'+token.slice(0,12)],coupon_design:design,coupon_draft_id:ctx.draftId});qaPromos.push(promo.id)
    assert.deepEqual(promo.coupon_design,design);assert.equal(promo.codes.length,1)
    const reopened=await invoke('getById',{},promo.id);assert.deepEqual(reopened.coupon_design,design)
    const linkedCtx={...ctx,promotionId:promo.id},[signed]=await assets.resolveCouponAssets(linkedCtx,[dto.id]);assert.ok(signed.url)
    await assert.rejects(assets.resolveCouponAssets({...linkedCtx,companyId:randomUUID()},[dto.id]),e=>e.status===404)
    await assert.rejects(assets.removeDraftCouponAsset(ctx,dto.id),e=>e.status===404)
    const replacement=await assets.uploadCouponAsset(linkedCtx,{mimetype:'image/png',buffer:image});qaAssets.push(replacement.id)
    const next={...design,background:{...design.background,assetId:replacement.id}}
    const changed=await invoke('update',{coupon_design:next,coupon_draft_id:ctx.draftId},promo.id);assert.deepEqual(changed.coupon_design,next)
    const oldAsset=await db.promotionCouponAsset.findUnique({where:{id:dto.id}});assert.ok(oldAsset.expires_at);assert.equal(oldAsset.status,'READY')
    await invoke('update',{active:false},promo.id);assert.deepEqual((await db.promotion.findUnique({where:{id:promo.id}})).coupon_design,next)
    await invoke('update',{coupon_design:null,coupon_draft_id:ctx.draftId},promo.id);assert.equal((await db.promotion.findUnique({where:{id:promo.id}})).coupon_design,null)
    console.log('QA: upload/claim/reopen/replace/active-only/null/foreign-scope verified')
  }finally{
    if(company){
      const rows=await db.promotionCouponAsset.findMany({where:{id:{in:qaAssets},company_id:company.id}})
      if(rows.length){const paths=rows.map(r=>{assert.equal(r.storage_path,`${company.id}/coupons/${r.id}.webp`);return r.storage_path});const{error}=await assertSupabase().storage.from('promotion-coupons').remove(paths);if(error)throw Error('Limpieza QA de Storage pendiente')}
      await db.promotionCouponAsset.deleteMany({where:{company_id:company.id}})
      await db.promotionCode.deleteMany({where:{company_id:company.id}})
      await db.promotion.deleteMany({where:{id:{in:qaPromos},company_id:company.id}})
      await db.userCompany.deleteMany({where:{company_id:company.id}})
      if(user)await db.user.delete({where:{id:user.id}})
      await db.company.delete({where:{id:company.id}})
    }
    if(old)require.cache[modulePath]=old;else delete require.cache[modulePath]
    await db.$disconnect()
  }
})
