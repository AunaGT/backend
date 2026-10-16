const{test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
require('../src/config/loadEnv')
const{PrismaClient,Prisma}=require('@prisma/client'),{couponStagingUrl}=require('../scripts/coupon-staging')
const fs=require('node:fs'),path=require('node:path')
const barrier=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
test('real PostgreSQL advisory contention makes cleanup wait for claim and reject tombstone reuse',async()=>{
  const url=couponStagingUrl(),admin=new PrismaClient({datasources:{db:{url}}}),schema='coupon_lock_qa_'+randomUUID().replace(/-/g,'')
  let db,restore=()=>{},resumeClaim,resumeStorage,claim,cleaning
  try{
    await admin.$transaction(async tx=>{
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`)
      await tx.$executeRawUnsafe('CREATE TABLE companies(id UUID PRIMARY KEY)')
      await tx.$executeRawUnsafe('CREATE TABLE users(id UUID PRIMARY KEY)')
      await tx.$executeRawUnsafe('CREATE TABLE promotions (LIKE public.promotions INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)')
      await tx.$executeRawUnsafe('ALTER TABLE promotions DROP COLUMN coupon_design')
      const sql=fs.readFileSync(require('../scripts/migrationFiles').migrationSqlPath('202610120001_promotion_coupon_design',{historical:true}),'utf8')
      for(const statement of sql.split(';').filter(s=>s.trim()))await tx.$executeRawUnsafe(statement)
    },{timeout:30000,maxWait:10000})
    const scoped=new URL(url);scoped.searchParams.set('schema',schema);db=new PrismaClient({datasources:{db:{url:scoped.toString()}}})
    const ctx={companyId:randomUUID(),userId:randomUUID(),draftId:randomUUID()},id=randomUUID(),promoId=randomUUID(),created=new Date()
    await db.$executeRawUnsafe(`INSERT INTO "${schema}".companies VALUES ($1::uuid)`,ctx.companyId)
    await db.$executeRawUnsafe(`INSERT INTO "${schema}".users VALUES ($1::uuid)`,ctx.userId)
    await db.promotion.create({data:{id:promoId,company_id:ctx.companyId,name:'Isolated lock QA',type_id:1,coupon_design:Prisma.DbNull}})
    await db.promotionCouponAsset.create({data:{id,company_id:ctx.companyId,created_by:ctx.userId,draft_id:ctx.draftId,promotion_id:promoId,storage_path:`${ctx.companyId}/coupons/${id}.webp`,status:'READY',width:10,height:10,created_at:created,expires_at:new Date(0)}})
    const entered=barrier(),claimed=barrier(),removed=[],storageReady=barrier();resumeClaim=barrier();resumeStorage=barrier();let blockStorage=false,cleanupPid
    const modelPath=require.resolve('../src/models/prisma'),storagePath=require.resolve('../src/services/supabaseStorage'),assetPath=require.resolve('../src/modules/promotions/couponAssets'),old=[require.cache[modelPath],require.cache[storagePath],require.cache[assetPath]]
    const scopedTransaction=async fn=>db.$transaction(async tx=>{await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}",public`);return fn(tx)},{timeout:30000,maxWait:10000})
    const proxy=new Proxy(db,{get(target,key){if(key==='$transaction')return fn=>scopedTransaction(async tx=>{cleanupPid=(await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;entered.resolve();return fn(tx)});const value=target[key];return typeof value==='function'?value.bind(target):value}})
    require.cache[modelPath]={id:modelPath,filename:modelPath,loaded:true,exports:{prisma:proxy}}
    require.cache[storagePath]={id:storagePath,filename:storagePath,loaded:true,exports:{assertSupabase:()=>({storage:{from:()=>({remove:async paths=>{if(blockStorage){storageReady.resolve();await resumeStorage.promise}removed.push(...paths);return{}}})}})}}
    delete require.cache[assetPath]
    restore=()=>{for(const[i,file]of [modelPath,storagePath,assetPath].entries())if(old[i])require.cache[file]=old[i];else delete require.cache[file]}
    const{claimCouponAssets,cleanupCouponAssets}=require('../src/modules/promotions/couponAssets')
    const design={background:{kind:'image',assetId:id,fit:'cover',focalX:.5,focalY:.5},elements:[]}
    claim=scopedTransaction(async tx=>{await claimCouponAssets(tx,ctx,promoId,design);claimed.resolve();await resumeClaim.promise;await tx.promotion.update({where:{id:promoId},data:{coupon_design:design}})})
    await claimed.promise;cleaning=cleanupCouponAssets({limit:50});await entered.promise
    let waiter=false
    for(let i=0;i<20&&!waiter;i++)waiter=(await admin.$queryRaw`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${cleanupPid} AND locktype='advisory' AND NOT granted) AS waiting`)[0].waiting
    assert.equal(waiter,true,'cleanup must be waiting on the actual company advisory lock')
    resumeClaim.resolve();await claim;await cleaning
    assert.equal(removed.length,0);assert.equal((await db.promotionCouponAsset.findUnique({where:{id}})).expires_at,null)
    await db.promotion.update({where:{id:promoId},data:{coupon_design:Prisma.DbNull}})
    await db.promotionCouponAsset.update({where:{id},data:{expires_at:new Date(0)}})
    blockStorage=true;cleaning=cleanupCouponAssets({limit:50});await storageReady.promise
    await assert.rejects(scopedTransaction(tx=>claimCouponAssets(tx,ctx,promoId,design)),e=>e.status===404)
    assert.equal((await db.promotion.findUnique({where:{id:promoId}})).coupon_design,null)
    resumeStorage.resolve();await cleaning
    assert.equal(await db.promotionCouponAsset.count(),0);assert.equal(removed.length,1)
    console.log('Actual PostgreSQL advisory waiter and claim/tombstone interleaving verified')
  }finally{
    resumeClaim?.resolve();resumeStorage?.resolve();await Promise.allSettled([claim,cleaning].filter(Boolean));restore();if(db)await db.$disconnect()
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.$disconnect()
  }
})
