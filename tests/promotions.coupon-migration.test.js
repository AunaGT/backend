const{test}=require('node:test'),assert=require('node:assert/strict')
const{couponStagingUrl}=require('../scripts/coupon-staging')
test('coupon migration guard refuses unapproved or unknown databases before opening connection',()=>{
  for(const env of [{},{AUNA_COUPON_STAGING_APPROVAL:'approved',DIRECT_URL:'postgresql://qa:qa@localhost:5432/postgres'},{AUNA_COUPON_STAGING_APPROVAL:'approved',DIRECT_URL:'postgresql://qa:qa@aws-1-us-east-2.pooler.supabase.com:6543/postgres'}])assert.throws(()=>couponStagingUrl(env))
  const allowed=couponStagingUrl({AUNA_COUPON_STAGING_APPROVAL:'approved',DIRECT_URL:'postgresql://qa:qa@aws-1-us-east-2.pooler.supabase.com:5432/postgres?schema=public'})
  assert.equal(new URL(allowed).searchParams.has('schema'),false)
})
