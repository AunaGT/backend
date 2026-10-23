const test=require('node:test'),assert=require('node:assert/strict')
const {Prisma}=require('@prisma/client')
const {lockPhysicalProducts}=require('../src/services/units/physical')
function fixture(rows){
 const calls=[]
 return{calls,db:{$executeRaw:async(sql,...values)=>{calls.push({kind:'lock',sql:String(sql),values:values.flatMap(value=>value?.values??[value])});return 1},product:{findMany:async args=>{calls.push({kind:'read',args});return rows}}}}
}
test('physical lock validates fresh scoped products with only one product read after the lock',async()=>{
 const product={id:'p',kind:'STANDARD',company_id:'A',stock:new Prisma.Decimal('1.125'),cost:new Prisma.Decimal('2.000000000001'),unit_revision:3}
 const f=fixture([product]),result=await lockPhysicalProducts(f.db,['p','p'],'B')
 assert.deepEqual(f.calls.map(call=>call.kind),['lock','read'])
 assert.match(f.calls[0].sql,/company_id/);assert.match(f.calls[0].sql,/branches/);assert.match(f.calls[0].sql,/ORDER BY id FOR UPDATE/)
 assert.ok(f.calls[0].values.includes('B'))
 assert.deepEqual(f.calls[1].args.where,{id:{in:['p']},company:{branches:{some:{id:'B'}}}})
 assert.equal(result.get('p'),product);assert.equal(result.get('p').cost.toFixed(),'2.000000000001')
})
test('physical lock rejects missing/foreign products and services before callers can write',async()=>{
 for(const rows of [[],[{id:'p',kind:'SERVICE'}]]){
  const f=fixture(rows);await assert.rejects(lockPhysicalProducts(f.db,['p'],'B'),error=>error.status===404||error.status===400)
 }
 const f=fixture([]);await assert.rejects(lockPhysicalProducts(f.db,['p'],null),/Sucursal requerida/);assert.deepEqual(f.calls,[])
 assert.deepEqual([...await lockPhysicalProducts(f.db,[],'B')],[]);assert.deepEqual(f.calls,[])
})
