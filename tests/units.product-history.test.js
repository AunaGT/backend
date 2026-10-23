const test=require('node:test')
const assert=require('node:assert/strict')
const {Prisma}=require('@prisma/client')
const {hasProductHistory}=require('../src/modules/inventory/units/catalog')
const productId='098e1d4e-7894-4961-b5ee-e14fcc2e3e25'

// Validate the query boundary against the installed Prisma schema, without a database connection.
function historyDatabase(records={}){
  const models=Prisma.dmmf.datamodel.models
  function validate(modelName,where){
    const model=models.find(m=>m.name===modelName)
    for(const [key,value] of Object.entries(where)){
      if(key==='OR'){for(const branch of value)validate(modelName,branch);continue}
      const field=model.fields.find(f=>f.name===key)
      assert.ok(field,`Unknown argument ${modelName}.${key}`)
      if(field.kind==='object')validate(field.type,value)
    }
  }
  function matches(row,where){
    return Object.entries(where).every(([key,value])=>{
      if(key==='OR')return value.some(branch=>matches(row,branch))
      if(value&&typeof value==='object')return Object.hasOwn(value,'not')?row[key]!==value.not:!!row[key]&&matches(row[key],value)
      return row[key]===value
    })
  }
  return Object.fromEntries(models.map(model=>[model.name[0].toLowerCase()+model.name.slice(1),{findFirst:async({where})=>{
    validate(model.name,where)
    return (records[model.name]||[]).find(row=>matches(row,where))||null
  }}]))
}

test('a new product without history checks valid Prisma fields and remains unlocked',async()=>{
  assert.equal(await hasProductHistory(historyDatabase(),productId),false)
})

test('delivery history follows the document line product and ignores other products',async()=>{
  const records={OrderDeliveryLine:[{id:'delivery-line',document_line:{product_id:productId}}]}
  assert.equal(await hasProductHistory(historyDatabase(records),productId),true)
  assert.equal(await hasProductHistory(historyDatabase(records),'another-product'),false)
})

test('direct histories, kit components and nonzero balances still lock the base unit',async()=>{
  for(const model of ['SaleItem','CommercialDocumentLine','PurchaseLog','IncomingMerchandiseItem','StockMovement','ProductLot','StockTransferLine','InventoryCountLine','ReturnItem','ReturnReplacementItem','StockReservation','AppointmentEngagementLine','AppointmentSession']){
    assert.equal(await hasProductHistory(historyDatabase({[model]:[{id:'history',product_id:productId}]}),productId),true,model)
  }
  for(const field of ['kit_product_id','component_product_id'])assert.equal(await hasProductHistory(historyDatabase({ProductBomLine:[{id:'kit', [field]:productId}]}),productId),true,field)
  for(const model of ['ProductStock','ProductStockLocation']){
    for(const stock of [1,-1])assert.equal(await hasProductHistory(historyDatabase({[model]:[{id:'balance',product_id:productId,stock}]}),productId),true,`${model}: ${stock}`)
    assert.equal(await hasProductHistory(historyDatabase({[model]:[{id:'balance',product_id:productId,stock:0}]}),productId),false,`${model}: zero`)
  }
})

test('a database failure is not mistaken for a product with no history',async()=>{
  const db=historyDatabase(),error=new Error('Connection reset by peer')
  db.orderDeliveryLine.findFirst=async()=>{throw error}
  await assert.rejects(hasProductHistory(db,productId),e=>e===error)
})
