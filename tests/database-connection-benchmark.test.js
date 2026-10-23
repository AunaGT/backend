const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const target=path.resolve(__dirname,'../scripts/benchmark-db-connections.js'),api=fs.existsSync(target)?require(target):{}
test('connection benchmark rejects invalid bounds and unknown CLI before connecting',()=>{
 assert.equal(typeof api.parseArgs,'function')
 for(const args of [['--samples=0'],['--samples=11'],['--samples=NaN'],['--connection-limit=3'],['--bad=1']])assert.throws(()=>api.parseArgs(args))
 assert.deepEqual(api.parseArgs([]),{samples:5,connectionLimit:1})
})
test('connection benchmark only runs bounded reads, disconnects sequential profiles and never changes environment',async()=>{
 assert.equal(typeof api.benchmarkConnections,'function');const env={DATABASE_URL:'postgresql://user:secret@a/db?pgbouncer=true&sslmode=require',DIRECT_URL:'postgresql://user:secret@b/db'},before={...env},events=[];let open=0,maximum=0
 class Client{
  constructor(options){events.push(options);open++;maximum=Math.max(open,maximum);this.listener=()=>{}}
  $on(_,fn){this.listener=fn}
  async $queryRawUnsafe(sql){assert.equal(sql,'SELECT 1');this.listener({query:sql});return[{one:1}]}
  async $executeRawUnsafe(sql){assert.equal(sql,'SET TRANSACTION READ ONLY');this.listener({query:sql})}
  async $transaction(fn){this.listener({query:'BEGIN'});const r=await fn(this);this.listener({query:'COMMIT'});return r}
  async $disconnect(){open--}
 }
 const result=await api.benchmarkConnections({env,options:{samples:2,connectionLimit:1},PrismaClient:Client})
 assert.equal(maximum,1);assert.equal(open,0);assert.deepEqual(env,before);assert.equal(result.length,2);assert.equal(result[0].warmMs.length,2);assert.equal(result[0].statements.SELECT,4);assert.equal(result[0].statements.SET,1)
 assert.equal(new URL(events[0].datasources.db.url).searchParams.get('pgbouncer'),'true');assert.equal(new URL(events[0].datasources.db.url).searchParams.get('connection_limit'),'1');assert.doesNotMatch(JSON.stringify(result),/secret|postgresql|user|@a|@b/)
})
test('failed or malformed profiles report only safe codes and still disconnect',async()=>{
 assert.equal(typeof api.benchmarkConnections,'function');let disconnected=0,constructed=0
 class Client{constructor(){constructed++}$on(){}async $queryRawUnsafe(){throw Object.assign(Error('postgresql://user:secret@private/db'),{code:'P1001'})}async $disconnect(){disconnected++}}
 const rows=await api.benchmarkConnections({env:{DATABASE_URL:'postgresql://user:secret@private/db',DIRECT_URL:'invalid-secret'},options:{samples:1,connectionLimit:1},PrismaClient:Client});assert.equal(constructed,1);assert.equal(disconnected,1);assert.deepEqual(rows,[{profile:'DATABASE_URL',status:'error',code:'P1001'},{profile:'DIRECT_URL',status:'error',code:'CONFIG_INVALID'}]);assert.doesNotMatch(JSON.stringify(rows),/secret|private/)
 const missing=await api.benchmarkConnections({env:{},options:{samples:1,connectionLimit:1},PrismaClient:Client});assert.deepEqual(missing.map(r=>r.code),['PROFILE_UNAVAILABLE','PROFILE_UNAVAILABLE'])
})
