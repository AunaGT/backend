const test=require('node:test'),assert=require('node:assert/strict'),express=require('express')
const {fixture}=require('./helpers/packagesDb')
test('package HTTP contract uses scoped catalog permissions and idempotent commands',async t=>{
  const f=fixture();let current=f.scope
  const app=express();app.use(express.json())
  app.use('/packages',require('../src/modules/inventory/packages/routes').createPackageRouter({db:f.db,scope:()=>current,auth:(_r,_s,next)=>next()}))
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const url=`http://127.0.0.1:${server.address().port}/packages`,input=f.input()
  const send=body=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  const saved=await send(input);assert.equal(saved.status,201);const receipt=await saved.json()
  assert.equal((await send(input)).status,201);assert.equal(f.state.packages.length,1)
  const list=await fetch(url+'?limit=1');assert.equal(list.status,200);assert.equal(list.headers.get('cache-control'),'no-store')
  assert.equal((await list.json()).items[0].id,receipt.id)
  assert.equal((await fetch(url+'/'+receipt.id)).status,200)
  current={...f.scope,permissions:['products.view']}
  assert.equal((await send(f.input())).status,403)
  current=f.scope;assert.equal((await send({...f.input(),price:'0'})).status,400)
  const invalid=await fetch(url+'?limit=101');assert.equal(invalid.status,400)
})
