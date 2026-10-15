const{test}=require('node:test'),assert=require('node:assert/strict'),{PrismaClient}=require('@prisma/client')
require('../src/config/loadEnv')
const{couponStagingUrl,rehearsal}=require('../scripts/coupon-staging')
test('exact coupon SQL rehearses in disposable guarded schema without changing live promotions',async()=>{
  const db=new PrismaClient({datasources:{db:{url:couponStagingUrl()}}})
  try{const before=await db.$queryRaw`SELECT count(*)::int AS n FROM public.promotions`;assert.equal(await rehearsal(db),true);assert.deepEqual(await db.$queryRaw`SELECT count(*)::int AS n FROM public.promotions`,before)}finally{await db.$disconnect()}
})
