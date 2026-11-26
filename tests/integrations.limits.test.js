const test=require('node:test'),assert=require('node:assert/strict')
test('shared atomic quota statements reject the first request beyond the per-key window',async()=>{
 const {consumeQuota}=require('../src/modules/integrations/limits'),counts=new Map()
 const db={$transaction:async f=>f(db),$queryRaw:async(sql,...values)=>{const [bucket,window,limit]=values,key=bucket+window.toISOString(),n=counts.get(key)||0;if(n>=limit)return[];counts.set(key,n+1);return[{count:n+1}]}}
 const context={credentialId:'key',companyId:'company'},now=new Date('2026-10-25T12:00:20Z')
 for(let i=0;i<120;i++)await consumeQuota(db,context,now)
 await assert.rejects(()=>consumeQuota(db,context,now),e=>e.status===429&&e.retryAfter===40)
 await consumeQuota(db,context,new Date('2026-10-25T12:01:00Z'))
})
