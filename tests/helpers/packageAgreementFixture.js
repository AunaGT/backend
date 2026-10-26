const {randomUUID}=require('node:crypto')
const {fixture}=require('./packagesDb')
const {selection,id}=require('./packageFixtures')
const catalog=require('../../src/modules/inventory/packages/catalog')
async function agreementFixture(){
  const f=fixture();f.scope.permissions.push('quotes.create')
  const saved=await catalog.savePackage(f.db,f.scope,null,f.input())
  await catalog.activatePackageVersion(f.db,f.scope,saved.id,{expectedVersion:saved.version,idempotencyKey:randomUUID()})
  return{...f,packageId:saved.id,selection:(items)=>({...selection(items),packageId:saved.id}),revision:id(300)}
}
module.exports={agreementFixture}
