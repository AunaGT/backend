const assert=require('node:assert/strict')
const {fingerprintRows,identifier}=require('../../scripts/migrations/inventory')
const history=require('../../scripts/migrations/history')
async function rehearseMigrationHistory(db,{schema,runId,baselineChecksum,paymentChecksum,resolve,verifyBusiness,url}){
  const [row]=await db.$queryRawUnsafe('SELECT oid::text AS oid FROM pg_class WHERE relnamespace=$1::regnamespace AND relname=$2',schema,'_prisma_migrations')
  const rows=await db.$queryRawUnsafe(`SELECT row_to_json(h)::text AS row FROM ${identifier(schema)}._prisma_migrations h ORDER BY id`)
  const r={qaSchema:schema,runId,historyOid:row.oid,historyHash:fingerprintRows(rows.map(r=>r.row)),baselineChecksum,paymentChecksum}
  const {PrismaClient}=require('@prisma/client'),gateDb=new PrismaClient({datasources:{db:{url}}})
  try{
    await history.withMigrationGate(gateDb,async gate=>{
      const held=await db.$transaction(tx=>tx.$queryRawUnsafe("SELECT pg_try_advisory_xact_lock(hashtextextended('auna:migrations:baseline:20261015',0)) AS acquired"),{timeout:30000})
      assert.equal(held[0].acquired,false)
      const cut=new Error('QA cut before archive commit')
      const interrupted={$queryRawUnsafe:db.$queryRawUnsafe.bind(db),$transaction:work=>db.$transaction(async tx=>{await work(tx);throw cut},{timeout:30000})}
      await assert.rejects(history.archiveHistory(interrupted,r),error=>error===cut)
      assert.equal(await history.inspectHistory(db,r),'CAPTURED')
      await gate.check();await history.archiveHistory(db,r)
      assert.equal(await history.inspectHistory(db,r),'ARCHIVED')
      await history.archiveHistory(db,r)
      await history.recoverHistory(db,r,{verifyBusiness})
      assert.equal(await history.inspectHistory(db,r),'CAPTURED')
      await history.archiveHistory(db,r)
      await gate.check();await resolve(gate.signal)
      assert.equal(await history.inspectHistory(db,r),'BASELINED')
      await db.$executeRawUnsafe(`CREATE TABLE ${identifier(schema)}._qa_unexpected(id integer)`)
      await assert.rejects(history.recoverHistory(db,r,{verifyBusiness}))
      assert.equal(await history.inspectHistory(db,r),'BASELINED')
      await db.$executeRawUnsafe(`DROP TABLE ${identifier(schema)}._qa_unexpected`)
      await history.recoverHistory(db,r,{verifyBusiness})
      assert.equal(await history.inspectHistory(db,r),'CAPTURED')
      await history.archiveHistory(db,r)
      await gate.check();await resolve(gate.signal)
      assert.equal(await history.inspectHistory(db,r),'BASELINED')
    })
    const released=await db.$transaction(tx=>tx.$queryRawUnsafe("SELECT pg_try_advisory_xact_lock(hashtextextended('auna:migrations:baseline:20261015',0)) AS acquired"),{timeout:30000})
    assert.equal(released[0].acquired,true)
    return r
  }finally{await gateDb.$disconnect()}
}
module.exports={rehearseMigrationHistory}
