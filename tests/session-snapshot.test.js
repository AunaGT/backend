const test=require('node:test'),assert=require('node:assert/strict')
const {withMocks}=require('./helpers/reportHarness.cjs')
const model=require.resolve('../src/models/prisma'),target=require.resolve('../src/services/userAccess')
const snapshot=()=>{try{return require('../src/services/sessionSnapshot')}catch(e){if(e.code==='MODULE_NOT_FOUND')return{};throw e}}
function fixture(){
 const row={id:'U',name:'Persona',auth_version:1,role_id:1,password_changed_at:new Date('2026-01-01'),created_at:new Date('2025-01-01'),user_companies:[{company_id:'A',role_id:2,status:'ACTIVE',company:{active:true}}],user_branches:[{branch:{id:'B',company_id:'A',active:true,is_default:true}}],_session_roles:[{id:1,name:'admin',system_key:'admin',company_id:null,permissions:[]},{id:2,name:'ventas',company_id:'A',permissions:[{permission:{code:'sales.create'}}]}],_session_valid:true,_password_required:false}
 const reads=[],db={$queryRaw:async(strings,...values)=>{reads.push({sql:String(strings),values});assert.match(String(strings),/FROM users u/);assert(values.includes('U'));return row.missing?[]:[structuredClone(row)]}}
 const load=(payload={sub:'U',auth_version:1,sid:'SID'},options={includeBranches:true})=>withMocks({[model]:{prisma:db}},target,access=>access.loadSessionUser(payload,options))
 return{row,reads,db,load}
}
test('fresh session loads all authority in one parameterized read and does not expose diagnostic fields',async()=>{
 assert.equal(typeof snapshot().readSessionSnapshot,'function');const f=fixture(),user=await f.load()
 assert.equal(f.reads.length,1);assert(!f.reads[0].sql.includes('SID'));assert(f.reads[0].values.includes('SID'))
 assert(user.created_at instanceof Date);assert.equal(user.role.id,1);assert.equal(user.user_companies[0].role.id,2)
 assert.equal(user.user_branches[0].branch.id,'B');assert.equal(user.must_change_password,false)
 assert.equal(Object.keys(user).some(key=>key.startsWith('_session')||key==='_password_required'),false)
 const access=require(target);assert(access.effectiveUser(user,'A').permissions.includes('sales.create'));assert.equal(access.effectiveUser(user,'A').role.system_key,undefined)
})
for(const [change,status]of [['revoked',401],['version',401],['membership',403],['company',403],['role',403],['missing',401]])test(`next request sees ${change} without reusing previous authorization`,async()=>{
 assert.equal(typeof snapshot().readSessionSnapshot,'function');const f=fixture();await f.load()
 if(change==='revoked')f.row._session_valid=false
 if(change==='version')f.row.auth_version++
 if(change==='membership')f.row.user_companies[0].status='BLOCKED'
 if(change==='company')f.row.user_companies[0].company.active=false
 if(change==='role')f.row._session_roles=f.row._session_roles.filter(r=>r.id!==2)
 if(change==='missing')f.row.missing=true
 await assert.rejects(f.load(),e=>e.status===status);assert.equal(f.reads.length,2)
})
test('next request sees reduced permissions, forced password change and rejects a foreign membership role',async()=>{
 assert.equal(typeof snapshot().readSessionSnapshot,'function');const f=fixture();await f.load()
 f.row._session_roles[1].permissions=[];f.row.password_changed_at=null;f.row._password_required=true
 const user=await f.load(),access=require(target);assert.equal(user.must_change_password,true);assert.deepEqual(access.effectiveUser(user,'A').permissions,[])
 f.row._session_roles[1].company_id='OTHER';await assert.rejects(f.load().then(u=>access.effectiveUser(u,'A')),e=>e.status===403)
})
test('snapshot omits unrequested branches and keeps legacy session behavior with no sid',async()=>{
 assert.equal(typeof snapshot().readSessionSnapshot,'function');const f=fixture()
 const user=await f.load({sub:'U',auth_version:1},{includeBranches:false})
 assert.equal(user.user_branches,undefined);assert(f.reads[0].values.includes(null))
})
