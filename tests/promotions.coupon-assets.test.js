const {test}=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp')
const {createCouponApiHarness,COMPANY,PROMO}=require('./helpers/couponApiHarness.cjs')
const photo=async()=>({mimetype:'image/png',buffer:await sharp({create:{width:3000,height:500,channels:4,background:'#ff7800'}}).png().toBuffer()})
test('coupon upload normalizes image, signs scoped DTO and rejects forged tenant/draft',async()=>{
  const h=createCouponApiHarness();try{
    const dto=await h.assets.uploadCouponAsset(h.ctx,await photo())
    assert.equal(dto.width,2400);assert.equal(dto.height,400);assert.ok(dto.url);assert.ok(!('storage_path'in dto))
    assert.equal((await sharp(h.calls[0].buffer).metadata()).format,'webp')
    await assert.rejects(h.assets.resolveCouponAssets({...h.ctx,companyId:PROMO},[dto.id]),e=>e.status===404)
    await assert.rejects(h.assets.resolveCouponAssets({...h.ctx,draftId:PROMO},[dto.id]),e=>e.status===404)
    await assert.rejects(h.assets.uploadCouponAsset(h.ctx,{mimetype:'image/png',buffer:Buffer.from('<svg/>')}),e=>e.status===400)
  }finally{h.restore()}
})
test('failed upload leaves retriable tombstone rather than READY resource',async()=>{
  const h=createCouponApiHarness(),logged=[],original=console.error;console.error=(...args)=>logged.push(args.join(' '))
  try{h.setStorageError(true);await assert.rejects(h.assets.uploadCouponAsset(h.ctx,await photo()),e=>e.status===503&&!/offline/.test(e.message));assert.equal(h.rows()[0].status,'DELETING')
    assert.ok(logged.some(line=>/offline/.test(line)),'the server log keeps the real Storage cause')}finally{console.error=original;h.restore()}
})
test('cleanup/claim race cannot delete resource claimed under lock or reuse tombstone',async()=>{
  const h=createCouponApiHarness();try{
    const dto=await h.assets.uploadCouponAsset(h.ctx,await photo())
    const design={background:{kind:'image',assetId:dto.id},elements:[]}
    await h.prisma.$transaction(tx=>h.assets.claimCouponAssets(tx,h.ctx,PROMO,design))
    h.savedPromotion().coupon_design=design
    h.rows()[0].expires_at=new Date(0)
    await h.assets.cleanupCouponAssets({limit:50})
    assert.equal(h.calls.filter(c=>c.op==='remove').length,0)
    assert.equal(h.rows()[0].expires_at,null)
    h.savedPromotion().coupon_design=null;h.rows()[0].expires_at=new Date(0)
    let arrived,release;const barrier=new Promise(r=>arrived=r),resume=new Promise(r=>release=r)
    h.setBeforeRemove(async()=>{arrived();await resume})
    const cleaning=h.assets.cleanupCouponAssets({limit:50});await barrier
    await assert.rejects(h.prisma.$transaction(tx=>h.assets.claimCouponAssets(tx,h.ctx,PROMO,design)),e=>e.status===404)
    release();await cleaning;assert.equal(h.rows().length,0)
    assert.ok(h.calls.at(-1).paths[0].startsWith(COMPANY+'/coupons/'))
  }finally{h.restore()}
})

test('a passing network failure is retried and the image is saved; a hung upload times out instead of staying UPLOADING',async()=>{
  const h=createCouponApiHarness(),original=console.error;console.error=()=>{}
  try{
    Object.assign(h.assets.uploadPolicy,{timeoutMs:50,retryDelaysMs:[0,0]})
    const upload=h.storage.upload;let attempts=0
    h.storage.upload=async(...args)=>{attempts++;if(attempts===1)throw Object.assign(Error('fetch failed'),{cause:{code:'UNABLE_TO_VERIFY_LEAF_SIGNATURE'}});if(attempts===2)return{error:Object.assign(Error('Bad gateway'),{status:502})};return upload(...args)}
    const dto=await h.assets.uploadCouponAsset(h.ctx,await photo())
    assert.equal(attempts,3);assert.equal(h.rows().find(r=>r.id===dto.id).status,'READY')
    attempts=0;h.storage.upload=()=>{attempts++;return new Promise(()=>{})}
    await assert.rejects(h.assets.uploadCouponAsset(h.ctx,await photo()),e=>e.status===503)
    assert.equal(attempts,3,'each hung attempt is cut by the timeout and retried')
    assert.equal(h.rows().at(-1).status,'DELETING','never left UPLOADING')
    attempts=0;h.storage.upload=async()=>{attempts++;return{error:Object.assign(Error('mime type not allowed'),{status:415})}}
    await assert.rejects(h.assets.uploadCouponAsset(h.ctx,await photo()),e=>e.status===503)
    assert.equal(attempts,1,'a definitive rejection is not retried')
  }finally{console.error=original;h.restore()}
})
