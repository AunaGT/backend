const test=require('node:test'),assert=require('node:assert/strict')
test('cleanup scheduler prevents overlap and delegates bounded batches without deleting credentials',async()=>{
 const {runIntegrationCleanup}=require('../src/jobs/integrationAuditCleanup')
 let finish,calls=0;const db={$executeRaw:async(sql,...values)=>{calls++;assert.doesNotMatch(sql.join(''),/DELETE FROM integration_credentials\b/);assert.equal(values.at(-1),500);if(calls===1)await new Promise(r=>finish=r);return 500}}
 const first=runIntegrationCleanup({db,now:new Date('2026-10-25T12:00:00Z')});await new Promise(r=>setImmediate(r));assert.deepEqual(await runIntegrationCleanup({db}),{skipped:true});finish();assert.deepEqual(await first,{events:500,quotas:500});assert.equal(calls,2)
})
test('cleanup rejects oversized batches and preserves exact retention cutoffs',async()=>{
 const {cleanupIntegrationHistory}=require('../src/modules/integrations/audit'),seen=[],now=new Date('2026-10-25T12:00:00Z'),db={$executeRaw:async(sql,...values)=>{seen.push({sql:sql.join(''),values});return 0}}
 await assert.rejects(()=>cleanupIntegrationHistory(db,{limit:501}),/limit/)
 await cleanupIntegrationHistory(db,{now,limit:5});assert.equal(seen.length,2);assert.equal(seen[0].values[0].getTime(),now-30*86400000);assert.equal(seen[0].values[1].getTime(),now-365*86400000);assert.equal(seen[1].values[0].getTime(),now-120000);assert.equal(seen[0].values.at(-1),5)
})
