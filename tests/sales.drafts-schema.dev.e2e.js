const test=require('node:test'),assert=require('node:assert/strict')
const {devDbEnabled,withDevDb}=require('./helpers/salesDevFixture.cjs')
test('development schema supports stable draft origin and fiscal evidence',{skip:!devDbEnabled},()=>withDevDb(async db=>{
  const columns=await db.$queryRaw`SELECT table_name,column_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('sales','sale_dtes','sale_history')`
  for(const [table,column]of [['sales','origin_engagement_id'],['sales','version'],['sales','confirmed_at'],['sale_dtes','company_id'],['sale_dtes','branch_id'],['sale_history','before'],['sale_history','input_hash']])
    assert.ok(columns.some(c=>c.table_name===table&&c.column_name===column),`${table}.${column} missing`)
  assert.equal(columns.find(c=>c.table_name==='sales'&&c.column_name==='payment_method_id').is_nullable,'YES')
  const indexes=await db.$queryRaw`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN ('sale_origin_engagement_key','sale_dte_company_authorization_key','sale_history_request_key')`
  assert.equal(indexes.length,3)
  const guards=await db.$queryRaw`SELECT conname FROM pg_constraint WHERE conname IN ('engagement_confirmed_sale_origin_fk','sale_origin_branch_fk','sale_dte_sale_branch_fk','sale_history_sale_branch_fk')`
  assert.equal(guards.length,4)
  const history=await db.$queryRaw`SELECT relrowsecurity FROM pg_class WHERE oid='public.sale_history'::regclass`
  assert.equal(history[0].relrowsecurity,true,'financial history must not be exposed directly through Supabase')
}))
