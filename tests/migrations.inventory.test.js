const test=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto')
const {compareInventory,fingerprintRows,captureInventory}=require('../scripts/migrations/inventory')
const {verifyReceipt,assertTarget,postgresEnv}=require('../scripts/reconcile-migrations')
test('changed definitions and removed objects cannot hide behind equal object counts',()=>{
  const before={constraints:[{table:'sales',name:'amount_check',definition:'CHECK (total >= 0)'}]}
  const after={constraints:[{table:'sales',name:'amount_check',definition:'CHECK (total >= -1)'}]}
  assert.notDeepEqual(compareInventory(after,before),[])
  assert.notDeepEqual(compareInventory({constraints:[]},before),[])
  assert.deepEqual(compareInventory(before,before),[])
})
test('fingerprints preserve amount changes but ignore row and property ordering',()=>{
  assert.notEqual(fingerprintRows([{id:'R',amount:'10.00'}]),fingerprintRows([{id:'R',amount:'11.00'}]))
  assert.equal(fingerprintRows([{id:'B',amount:'1'},{id:'A',amount:'2'}]),fingerprintRows([{amount:'2',id:'A'},{amount:'1',id:'B'}]))
})
test('physical dropped-column holes do not alter logical column order equivalence',()=>{
  const source={columns:[{table:'sales',name:'id',position:1},{table:'sales',name:'total',position:3}]}
  const rebuilt={columns:[{table:'sales',name:'id',position:1},{table:'sales',name:'total',position:2}]}
  assert.deepEqual(compareInventory(rebuilt,source),[])
  assert.notDeepEqual(compareInventory({columns:[...rebuilt.columns].reverse()},source),[])
})
test('enum order and exact varchar text-array casts survive PostgreSQL dump reparse without hiding changed values',()=>{
  const before={types:[{name:'Status',label:'A',position:'1'},{name:'Status',label:'B',position:'1.5'}],constraints:[{definition:"CHECK (state::text = ANY (ARRAY['A'::character varying, 'B'::character varying]::text[]))"}],indexes:[{definition:"WHERE ((state)::text = ANY ((ARRAY['A'::character varying, 'B'::character varying])::text[]))"}]}
  const after={types:[{name:'Status',label:'A',position:'1'},{name:'Status',label:'B',position:'2'}],constraints:[{definition:"CHECK (state::text = ANY (ARRAY['A'::character varying::text, 'B'::character varying::text]))"}],indexes:[{definition:"WHERE ((state)::text = ANY (ARRAY[('A'::character varying)::text, ('B'::character varying)::text]))"}]}
  assert.deepEqual(compareInventory(after,before),[])
  assert.notDeepEqual(compareInventory({...after,types:[...after.types].reverse()},before),[])
  assert.notDeepEqual(compareInventory({...after,constraints:[{definition:after.constraints[0].definition.replace("'B'","'C'")}]},before),[])
})
test('sequence metadata is exposed as serializable text to the Prisma boundary',async()=>{
  const db={$queryRawUnsafe:async sql=>{
    if(!sql.includes('FROM pg_sequences'))return[]
    if(!sql.includes('data_type::text'))throw new Error('Unsupported regtype')
    return[{name:'sales_seq',data_type:'bigint'}]
  }}
  assert.deepEqual((await captureInventory(db,'public')).sequences,[{name:'sales_seq',data_type:'bigint'}])
})
test('target guard checks original project, port and fresh opt-in',()=>{
  const url='postgresql://u:secret@db.example:5432/postgres?schema=public'
  const {connectionIdentity}=require('../scripts/salesDevTarget')
  const receipt={identity:connectionIdentity(url),target:{host:'db.example',database:'postgres',directPort:'5432'}}
  assertTarget(url,receipt,{AUNA_BASELINE_DEV:'1'})
  for(const [raw,env]of [[url,{}],[url.replace('5432','6543'),{AUNA_BASELINE_DEV:'1'}],[url.replace('u:','other:'),{AUNA_BASELINE_DEV:'1'}]])
    assert.throws(()=>assertTarget(raw,receipt,env))
  assert.equal(postgresEnv(url,{}).PGPASSWORD,'secret')
  assert.equal(Object.values(postgresEnv(url,{})).includes(url),false)
})
test('backup receipts reject changed bytes, wrong identity and missing table data',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auna-inventory-unit-'))
  try{
    const file=path.join(dir,'public.dump');fs.writeFileSync(file,'backup')
    const receipt={formatVersion:1,identity:'A',backup:{file,checksum:crypto.createHash('sha256').update('backup').digest('hex')},inventory:{tables:[{name:'sales'},{name:'users'}]}}
    const list=()=> '1; TABLE DATA public sales postgres\n2; TABLE DATA public users postgres\n3; TABLE DATA public _prisma_migrations postgres'
    assert.equal(verifyReceipt(receipt,'A',list),receipt)
    assert.throws(()=>verifyReceipt(receipt,'B',list),/identity/i)
    assert.throws(()=>verifyReceipt(receipt,'A',()=> 'TABLE DATA public sales postgres'),/incomplete/i)
    fs.appendFileSync(file,'changed')
    assert.throws(()=>verifyReceipt(receipt,'A',list),/checksum/i)
  }finally{fs.rmSync(dir,{recursive:true})}
})
