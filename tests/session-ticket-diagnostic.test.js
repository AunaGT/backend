const test=require('node:test'),assert=require('node:assert/strict')
const api=()=>{try{return require('../scripts/diagnose-session-ticket')}catch(e){if(e.code==='MODULE_NOT_FOUND')return{};throw e}}
test('session/ticket diagnostic requires explicit rollback and rejects every expanded scope',()=>{
 assert.equal(typeof api().parseDiagnosticArgs,'function');assert.equal(api().parseDiagnosticArgs(['--rollback']),true)
 for(const args of [[],['--commit'],['--rollback','--company=other'],['--rollback','--rollback']])assert.throws(()=>api().parseDiagnosticArgs(args),e=>e.message==='ROLLBACK_OPT_IN_REQUIRED')
})
test('diagnostic output keeps only fixed codes, never arbitrary messages or connection secrets',()=>{
 assert.equal(typeof api().safeErrorCode,'function')
 assert.equal(api().safeErrorCode({code:'P1001',message:'postgres://secret'}),'P1001')
 assert.equal(api().safeErrorCode({message:'ROLLBACK_OPT_IN_REQUIRED'}),'ROLLBACK_OPT_IN_REQUIRED')
 for(const e of [{message:'SECRET_PASSWORD'},{code:'PRIVATE_SECRET'},{message:'postgres://secret'},{}])assert.equal(api().safeErrorCode(e),'DIAGNOSTIC_FAILED')
})
test('authorization parity compares values rather than JSON object key order and catches a permission change',()=>{
 assert.equal(typeof api().equivalentAuthority,'function')
 const a={id:'U',auth_version:1,must_change_password:false,default_branch_id:'B',role:{id:1,name:'lector',permissions:[]},user_companies:[{company_id:'C',status:'ACTIVE',company:{active:true},role:null}],user_branches:[{branch:{id:'B',company_id:'C',active:true,is_default:true}}]}
 const b={...structuredClone(a),user_branches:[{branch:{is_default:true,active:true,company_id:'C',id:'B'}}]}
 assert.equal(api().equivalentAuthority(a,b),true)
 b.role.permissions=[{permission:{code:'sales.create'}}];assert.equal(api().equivalentAuthority(a,b),false)
})
