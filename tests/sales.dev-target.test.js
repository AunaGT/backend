const test=require('node:test')
const assert=require('node:assert/strict')
let assertDevTarget
try { ({assertDevTarget}=require('./helpers/salesDevFixture.cjs')) } catch(error) { if(error.code!=='MODULE_NOT_FOUND')throw error }

test('development writes require exact destination and explicit opt-in',()=>{
  assert.equal(typeof assertDevTarget,'function')
  const url='postgresql://u:p@dev.example:5432/postgres'
  const identity=require('node:crypto').createHash('sha256').update('dev.example|u|postgres').digest('hex')
  const base={connectionUrl:url,approvedHost:'dev.example',approvedDatabase:'postgres',approved:true,approvedIdentity:identity}
  assert.deepEqual(assertDevTarget(base),{host:'dev.example',database:'postgres'})
  assert.throws(()=>assertDevTarget({...base,approved:false}),/approval/i)
  assert.throws(()=>assertDevTarget({...base,approvedHost:'another.example'}),/destination/i)
  assert.throws(()=>assertDevTarget({...base,approvedDatabase:'other'}),/destination/i)
  assert.throws(()=>assertDevTarget({...base,connectionUrl:url.replace('u:p','other:p')}),/identity/i)
  assert.throws(()=>assertDevTarget({...base,connectionUrl:'https://dev.example/postgres'}),/protocol/i)
  assert.throws(()=>assertDevTarget({...base,connectionUrl:base.connectionUrl+'?schema=another'}),/schema/i)
})
