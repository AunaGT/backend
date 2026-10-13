const test=require('node:test')
const assert=require('node:assert/strict')
test('promotion preview rejects invalid monetary input rather than returning a server error',async()=>{
  const {loadPromotionCart}=require('../src/modules/promotions/validation')
  const tx={product:{findMany:async()=>[{id:'b',kind:'STANDARD',quantity_decimals:0,category_id:1}]}}
  for(const price of [null,'NaN','-1','1.001','10000000000',{},'1e2']) await assert.rejects(loadPromotionCart(tx,[{product_id:'b',qty:1,price}],'A'),error=>error.status===400)
})
const {applyPromotion}=require('../src/services/promotionCalculator')
test('physical promotions cannot discount services, including category scopes and minimum quantities',()=>{
  const items=[{product_id:'s',kind:'SERVICE',category_id:1,price:100,qty:'2'}]
  for(const name of ['BUY_X_GET_Y','COMBO_DISCOUNT','FREE_GIFT','MIN_QTY_DISCOUNT']){
    const result=applyPromotion({type:{name},applies_to_all:true,applicable_categories:[{category_id:1}],buy_quantity:1,get_quantity:1,min_quantity:1,discount_percentage:50,trigger_product_id:'s',target_product_id:'s'},items)
    assert.equal(result.discount,0,name)
  }
})
test('percentage and fixed discounts support fractional service quantities with exact rounding',()=>{
  assert.equal(applyPromotion({type:{name:'PERCENTAGE'},applies_to_all:true,discount_percentage:10},[{product_id:'s',kind:'SERVICE',price:'19.99',qty:'1.25'}]).discount,2.5)
  assert.equal(applyPromotion({type:{name:'FIXED_AMOUNT'},discount_value:10},[{product_id:'s',kind:'SERVICE',price:100,qty:'1.5'}]).discount,10)
})
test('saving physical promotion targets rejects services and foreign catalog references',async()=>{
  const {validatePromotionCatalog}=require('../src/modules/promotions/validation')
  const tx={product:{findMany:async()=>[{id:'s',kind:'SERVICE'}]},systemSetting:{findUnique:async()=>({value:'true'})}}
  await assert.rejects(validatePromotionCatalog(tx,{trigger_product_id:'s',target_product_id:'s'},'FREE_GIFT','A'),/servicio/i)
  await validatePromotionCatalog(tx,{product_ids:['s']},'PERCENTAGE','A')
  tx.product.findMany=async()=>[]
  await assert.rejects(validatePromotionCatalog(tx,{product_ids:['foreign']},'PERCENTAGE','A'),/empresa|encontrado/i)
})
test('promotion preview loads the actual tenant item kind instead of trusting browser flags',async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  const model=require.resolve('../src/models/prisma'),target=require.resolve('../src/modules/promotions/controller')
  const prisma={promotion:{findFirst:async()=>({id:'p',type:{name:'BUY_X_GET_Y'},applies_to_all:true,buy_quantity:1,get_quantity:1})},product:{findMany:async()=>[{id:'s',kind:'SERVICE',quantity_decimals:2,category_id:1}]},systemSetting:{findUnique:async()=>({value:'true'})}}
  await withMocks({[model]:{prisma}},target,async controller=>{
    const res=jsonResponse()
    await controller.calculateDiscount({companyId:'A',body:{promotion_id:'p',items:[{product_id:'s',price:100,qty:2,kind:'STANDARD'}]}},res,error=>{throw error})
    assert.equal(res.body.discount,0)
  })
})
