const test=require('node:test'),assert=require('node:assert/strict'),jwt=require('jwt-simple')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs'),{secret}=require('../src/config/security')
const model=require.resolve('../src/models/prisma'),tenant=require.resolve('../src/middlewares/tenant')
function fixture(){
 const role=(id,name,company_id,code)=>({id,name,company_id,permissions:[{permission:{code}}]})
 const user={id:'U',auth_version:1,role_id:1,password_changed_at:new Date(),default_branch_id:'BA',role:role(1,'lector',null,'products.view'),user_companies:[{company_id:'A',role_id:2,status:'ACTIVE',company:{active:true},role:role(2,'ventas','A','sales.create')},{company_id:'B',role_id:3,status:'ACTIVE',company:{active:true},role:role(3,'lector','B','products.view')}],user_branches:[{branch:{id:'BA',company_id:'A',active:true,is_default:true}},{branch:{id:'BB',company_id:'B',active:true,is_default:true}}]}
 const reads=[];let refresh=true,passwordRequired=false
 const db={$queryRaw:async(strings,...values)=>{reads.push({sql:String(strings),values});assert.match(String(strings),/FROM users u/);assert(values.includes('U'));return[{...structuredClone(user),_session_roles:structuredClone([user.role,...user.user_companies.map(m=>m.role)]),_session_valid:refresh,_password_required:!user.password_changed_at&&passwordRequired}]},branch:{findMany:async()=>[{id:'BA'},{id:'OTHER-A'}]}}
 const payload={sub:'U',auth_version:1,sid:'S',exp:Math.floor(Date.now()/1000)+3600}
 const request=(headers={},method='GET',path='/products')=>({headers:{authorization:'Bearer '+jwt.encode(payload,secret),...headers},method,path})
 const run=async(req,auth=true)=>withMocks({[model]:{prisma:db}},tenant,async({resolveTenant})=>{const res=jsonResponse();res.send=res.json;let next=false,error;await resolveTenant(req,res,e=>{error=e;next=true});if(error)throw error;if(auth&&next){next=false;await require('../src/middlewares/autenticacion').Auth(req,res,e=>{error=e;next=true});if(error)throw error}return{req,res,next}})
 return{user,reads,request,run,payload,revoke:()=>refresh=false,requirePassword:()=>{user.password_changed_at=null;passwordRequired=true}}
}
test('tenant and Auth share one root user read, with explicit branch and active-company projection',async()=>{
 const f=fixture(),r=await f.run(f.request({'x-company-id':'A','x-branch-id':'BA'}));assert.equal(r.next,true);assert.equal(r.req.branchId,'BA');assert.ok(r.req.user.permissions.includes('sales.create'));assert.equal(f.reads.length,1);assert.equal(r.req.sessionUser.user_companies[0].company.active,true);assert.equal(r.req.sessionUser.user_branches[1].branch.id,'BB')
})
test('switching company derives its own role and default branch rather than the previous company',async()=>{
 const f=fixture(),a=await f.run(f.request({'x-company-id':'A'})),b=await f.run(f.request({'x-company-id':'B'}));assert.equal(a.req.branchId,'BA');assert.equal(b.req.branchId,'BB');assert.equal(b.req.user.permissions.includes('sales.create'),false);assert.ok(b.req.user.permissions.includes('products.view'));assert.deepEqual(b.req.userBranchIds,['BB'])
})
test('session roles and permissions arrive in the same fresh read shared by tenant and Auth',async()=>{
 const f=fixture(),r=await f.run(f.request({'x-company-id':'A'}));assert.equal(f.reads.length,1);assert.equal(r.req.sessionUser.role.id,1);assert.deepEqual(r.req.sessionUser.user_companies.map(m=>m.role.id),[2,3])
})
test('a missing explicit membership role cannot silently fall back to the global role',async()=>{
 const f=fixture();f.user.user_companies[0].role.id=999;const result=await f.run(f.request({'x-company-id':'A'}));assert.equal(result.next,false);assert.equal(result.res.statusCode,403)
})
for(const change of ['membership','company','version','refresh','branch'])test(`the next request rejects changed ${change} without global authorization cache`,async()=>{
 const f=fixture();assert.equal((await f.run(f.request({'x-company-id':'A'}))).next,true)
 if(change==='membership')f.user.user_companies[0].status='BLOCKED'
 if(change==='company')f.user.user_companies[0].company.active=false
 if(change==='version')f.user.auth_version++
 if(change==='refresh')f.revoke()
 if(change==='branch')f.user.user_branches[0].branch.active=false
 const r=await f.run(f.request({'x-company-id':'A','x-branch-id':'BA'}));assert.equal(r.next,false);assert.equal(r.res.statusCode,['version','refresh'].includes(change)?401:403)
})
test('company active state also applies to standalone session authorization',async()=>{
 const f=fixture();f.user.user_companies[0].company.active=false;f.user.user_companies[1].status='BLOCKED';const r=await f.run(f.request({},'GET','/auth/me'));assert.equal(r.next,false);assert.equal(r.res.statusCode,403)
})
test('consolidated stays read-only and requires the effective company permission',async()=>{
 const f=fixture();let r=await f.run(f.request({'x-company-id':'A','x-branch-id':'all'}));assert.equal(r.res.statusCode,403)
 f.user.user_companies[0].role.permissions.push({permission:{code:'branches.view_all'}})
 r=await f.run(f.request({'x-company-id':'A','x-branch-id':'all'}));assert.equal(r.next,true);assert.equal(r.req.branchId,null);assert.deepEqual(r.req.branchIds,['BA','OTHER-A'])
 r=await f.run(f.request({'x-company-id':'A','x-branch-id':'all'},'POST'));assert.equal(r.res.statusCode,400)
})
test('password-change restriction remains enforced after sharing tenant context',async()=>{
 const f=fixture();f.requirePassword();const r=await f.run(f.request({'x-company-id':'A'}));assert.equal(r.next,false);assert.equal(r.res.statusCode,403)
})
