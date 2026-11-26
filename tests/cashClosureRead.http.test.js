const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const req=permissions=>({companyId:randomUUID(),branchId:randomUUID(),user:{sub:randomUUID(),permissions,role:{name:'Cajero'}},query:{},params:{id:randomUUID()}})
async function call(api,action,request){const res=jsonResponse(),headers={};res.set=(k,v)=>{headers[k]=v;return res};let error;await api[action](request,res,e=>error=e);return {res,error,headers}}
test('closure controllers enforce the read scope before querying private details and summaries',async()=>{
 const queries=require.resolve('../src/modules/cash-closure/readQueries'),prisma=require.resolve('../src/models/prisma'),controller=require.resolve('../src/modules/cash-closure/controller')
 const seen=[],db={cashClosure:{findMany:async()=>[],findFirst:async()=>{throw Error('must not fetch unauthorized detail')}}}
 await withMocks({[prisma]:{prisma:db},[queries]:{readPage:async(_,scope)=>{seen.push(scope);return {ids:[],page:1,pageSize:20,totalPages:1,totalItems:0}},assertReadable:async()=>{throw Object.assign(Error('Cierre de caja no encontrado'),{status:404})}}},controller,async api=>{
   let result=await call(api,'list',req(['cashclosure.view']));assert.equal(result.error,undefined);assert.equal(result.res.body.totalItems,0);assert.equal(seen[0].mode,'mine');assert.equal(result.headers['Cache-Control'],'private, no-store')
   result=await call(api,'list',{...req(['cashclosure.view']),query:{scope:'team'}});assert.equal(result.error.status,403);assert.equal(seen.length,1)
   result=await call(api,'getById',req(['cashclosure.view']));assert.equal(result.error.status,404)
   result=await call(api,'getById',{...req(['cashclosure.view_team']),integration:{}});assert.equal(result.error.status,401)
 })
})
test('static read capabilities precede ids and team readers cannot execute closure commands',async()=>{
 const router=require('../src/modules/cash-closure/routes'),paths=router.stack.filter(l=>l.route).map(l=>Object.keys(l.route.methods)[0]+' '+l.route.path)
 assert.ok(paths.indexOf('get /read-capabilities')>=0);assert.ok(paths.indexOf('get /read-capabilities')<paths.indexOf('get /:id'))
 const {readScope}=require('../src/modules/cash-closure/readAccess'),{reviewScope}=require('../src/modules/cash-closure/reviewFlow.access'),{closureScope}=require('../src/modules/cash-closure/access')
 const r=req(['cashclosure.view_team']);assert.equal(readScope(r).viewTeam,true);assert.throws(()=>reviewScope(r,'review'),e=>e.status===403)
 assert.equal(closureScope(r,true).allowed,false);assert.equal(closureScope(r,false).allowed,false)
})
test('last date scopes preserve creation authority without granting history to creators',()=>{
 const {lastDateScope,readScope}=require('../src/modules/cash-closure/readAccess')
 assert.equal(lastDateScope(req(['cashclosure.create_day']),'day').mode,'team')
 assert.equal(lastDateScope(req(['cashclosure.create_own']),'mine').mode,'mine')
 assert.throws(()=>lastDateScope(req(['cashclosure.create_own']),'day'),e=>e.status===403)
 assert.throws(()=>lastDateScope(req(['cashclosure.view']),'day'),e=>e.status===403)
 assert.throws(()=>readScope(req(['cashclosure.create_day'])) ,e=>e.status===403)
})
