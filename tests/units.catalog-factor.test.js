const test=require('node:test'),assert=require('node:assert/strict'),{Prisma}=require('@prisma/client')
const units=require('../src/modules/inventory/units'),{database,scope}=require('./units.catalog.test')
test('full used-unit rename preserves an equal tiny Decimal factor but refuses a real conversion change',async()=>{
  const {db,state}=database();state.units[0].factor=new Prisma.Decimal('0.000000000001')
  const payload={code:'KG',family:'MASS',name:'Nombre nuevo',label:'etiqueta',factor:'0.000000000001',quantity_decimals:6}
  const saved=await units.saveUnit(db,scope,payload,'kg')
  assert.equal(saved.name,'Nombre nuevo');assert.equal(saved.label,'etiqueta');assert.equal(units.factorText(saved.factor),'0.000000000001')
  await assert.rejects(units.saveUnit(db,scope,{...payload,factor:'0.000000000002'},'kg'),e=>e.status===409)
  assert.equal(units.factorText(state.units[0].factor),'0.000000000001')
})
