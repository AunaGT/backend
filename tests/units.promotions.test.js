const test=require('node:test'),assert=require('node:assert/strict')
const {applyPromotion}=require('../src/services/promotionCalculator')
const count={version:2,baseUnit:{id:'U',code:'UNIT',decimals:0},presentation:{id:'BOX',version:1},factor:'7'}
function item(product_id,qty,base_qty,price,snapshot=count){return{product_id,qty,base_qty,price,item_kind:'STANDARD',unit_metadata_version:2,unit_snapshot:snapshot}}
test('BXGY counts base units once across split presentations and excludes measured targets explicitly',()=>{
  const promo={type:{name:'BUY_X_GET_Y'},applies_to_all:true,buy_quantity:7,get_quantity:1}
  const whole=applyPromotion(promo,[item('P','1','7','14')])
  const split=applyPromotion(promo,[item('P','1','3','6'),item('P','2','4','4')])
  assert.equal(whole.discount,2);assert.equal(split.discount,2)
  const measured=applyPromotion(promo,[item('KG','7','7','2',{version:2,baseUnit:{code:'KG',decimals:6},presentation:null,factor:'1'})])
  assert.equal(measured.discount,0);assert.equal(measured.details.referenceUnit,'UNIT');assert.deepEqual(measured.details.excludedProducts,['KG'])
})

test('BXGY resolves its public kilogram trigger and gram gift reference before grouping split presentations',async()=>{
  const {resolvePromotionReference,withPromotionBaseUnits}=require('../src/services/units/promotionReference')
  const units={KG:{id:'KG',company_id:'A',code:'KG',family:'MASS',factor:'1'},G:{id:'G',company_id:'A',code:'G',family:'MASS',factor:'0.001'}}
  const tx={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'})},measureUnit:{findFirst:async({where})=>units[where.id]||null},product:{findMany:async()=>[{id:'P',kind:'STANDARD',base_unit:units.KG}]}}
  const payload={product_ids:['P'],buy_quantity:'1',get_quantity:'250',quantity_reference:{trigger_unit_id:'KG',gift_unit_id:'G'}}
  const reference=await resolvePromotionReference(tx,'A',payload,'BUY_X_GET_Y')
  const rule={...payload,type:{name:'BUY_X_GET_Y'},quantity_reference:reference,applicable_products:[{product_id:'P'}]}
  const baseSnapshot={version:2,baseUnit:{id:'KG',code:'KG',decimals:6},presentation:null,factor:'1'}
  for(const lines of [[{...item('P','1','1','20',baseSnapshot),line_total:'20'}],[
    {...item('P','1','0.4','8',{...baseSnapshot,factor:'0.4',presentation:{id:'P4',version:1,decimals:0}}),line_total:'8'},
    {...item('P','1','0.6','12',{...baseSnapshot,factor:'0.6',presentation:{id:'P6',version:1,decimals:0}}),line_total:'12'},
  ]]){
    const result=applyPromotion(rule,await withPromotionBaseUnits(tx,lines,'A'))
    assert.equal(result.discount,5)
    assert.equal(result.details.referenceUnit,'KG');assert.equal(result.details.giftReferenceUnit,'G')
    assert.equal(result.details.itemsAffected[0].freeQty,0.25)
    assert.equal(result.details.itemsAffected[0].freeQtyReferenceUnit,'KG')
  }
  const ownReference=await resolvePromotionReference(tx,'A',{...payload,get_quantity:'0.25',quantity_reference:{trigger_unit_id:'KG'}},'BUY_X_GET_Y')
  assert.equal(applyPromotion({...rule,get_quantity:'0.25',quantity_reference:ownReference},await withPromotionBaseUnits(tx,[{...item('P','1','1','20',baseSnapshot),line_total:'20'}],'A')).discount,5)
})

test('BXGY reference writer rejects an incompatible gift family for the same discounted product',async()=>{
  const {resolvePromotionReference}=require('../src/services/units/promotionReference')
  const units={KG:{id:'KG',company_id:'A',code:'KG',family:'MASS',factor:'1'},L:{id:'L',company_id:'A',code:'L',family:'VOLUME',factor:'1'}}
  const tx={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'})},measureUnit:{findFirst:async({where})=>units[where.id]||null},product:{findMany:async()=>[{id:'P',kind:'STANDARD',base_unit:units.KG}]}}
  await assert.rejects(resolvePromotionReference(tx,'A',{product_ids:['P'],buy_quantity:'1',get_quantity:'250',quantity_reference:{trigger_unit_id:'KG',gift_unit_id:'L'}},'BUY_X_GET_Y'),e=>e.status===400)
})

test('measured combo discounts only the available target fraction and keeps whole-unit UNIT behavior',async()=>{
  const {resolvePromotionReference,withPromotionBaseUnits}=require('../src/services/units/promotionReference')
  const units={KG:{id:'KG',company_id:'A',code:'KG',family:'MASS',factor:'1'},L:{id:'L',company_id:'A',code:'L',family:'VOLUME',factor:'1'},UNIT:{id:'UNIT',company_id:'A',code:'UNIT',family:'COUNT',factor:'1'}}
  for(const [triggerUnit,targetUnit,cases]of [['KG','L',[['0.25','5',2.5,5],['1','20',10,20],['2','40',10,20]]],['UNIT','UNIT',[['1','20',10,20],['2','40',10,20]]]]){
    const products=[{id:'A',kind:'STANDARD',base_unit:units[triggerUnit]},{id:'B',kind:'STANDARD',base_unit:units[targetUnit]}]
    const tx={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'})},measureUnit:{findFirst:async({where})=>units[where.id]||null},product:{findMany:async()=>products}}
    const payload={trigger_product_id:'A',target_product_id:'B',quantity_reference:{trigger_unit_id:triggerUnit,gift_unit_id:targetUnit}}
    const reference=await resolvePromotionReference(tx,'A',payload,'COMBO_DISCOUNT')
    const rule={...payload,type:{name:'COMBO_DISCOUNT'},quantity_reference:reference}
    for(const [qty,total,percentageDiscount,fixedDiscount]of cases){
      const triggerSnapshot={version:2,baseUnit:{id:triggerUnit,code:triggerUnit,decimals:triggerUnit==='UNIT'?0:6},presentation:null,factor:'1'}
      const targetSnapshot={version:2,baseUnit:{id:targetUnit,code:targetUnit,decimals:targetUnit==='UNIT'?0:6},presentation:null,factor:'1'}
      const cart=await withPromotionBaseUnits(tx,[{...item('A','1','1','20',triggerSnapshot),line_total:'20'},{...item('B',qty,qty,'20',targetSnapshot),line_total:total}],'A')
      assert.equal(applyPromotion({...rule,discount_percentage:'50'},cart).discount,percentageDiscount)
      assert.equal(applyPromotion({...rule,discount_value:'100'},cart).discount,fixedDiscount)
      assert.equal(applyPromotion({...rule,discount_value:'2'},cart).discount,2)
      if(triggerUnit==='UNIT'){
        const legacy=cart.map(({unit_metadata_version,unit_snapshot,base_qty,...line})=>line)
        assert.equal(applyPromotion({...rule,quantity_reference:null,discount_percentage:'50'},legacy).discount,percentageDiscount)
        assert.equal(applyPromotion({...rule,quantity_reference:null,discount_value:'100'},legacy).discount,fixedDiscount)
      }
    }
  }
})
test('a free gift uses the target own base factor rather than granting its whole box price',()=>{
  const result=applyPromotion({type:{name:'FREE_GIFT'},trigger_product_id:'A',target_product_id:'B'},[item('A','1','7','14'),item('B','1','4','20',{...count,factor:'4'})])
  assert.equal(result.discount,5)
})
test('percentage and fixed discounts use the final commercial line bases with exact cents',()=>{
  const cart=[{...item('P','1','7','1.005'),line_total:'1.01'},{...item('B','1','4','1.005'),line_total:'1.01'}]
  assert.equal(applyPromotion({type:{name:'PERCENTAGE'},applies_to_all:true,discount_percentage:'50'},cart).discount,1.01)
  assert.equal(applyPromotion({type:{name:'FIXED_AMOUNT'},discount_value:'2.02'},cart).discount,2.02)
  assert.equal(applyPromotion({type:{name:'PERCENTAGE'},discount_percentage:'50',min_purchase_amount:'2.02',applicable_products:[{product_id:'P'},{product_id:'B'}]},cart).discount,1.01)
})

test('CMV uses frozen base quantity and cost even if the commercial rate was rounded',()=>{
  const {buildSalePosting,buildReturnPosting}=require('../src/services/accounting/postingEngine')
  const defaults=Object.fromEntries(['cash','bank','sales','inventory','cogs','receivables','salesReturns','ivaDebit','pequenoTax','pequenoTaxExpense'].map(id=>[id,{id}]))
  const config={defaults,splitVat:false,ivaRate:0,costBase:v=>v,pequenoTaxOf:()=>0}
  const sale=buildSalePosting({total:'10',payment_method:{name:'Efectivo'},sale_items:[{...item('P','10000000','1','0.0000001'),unit_cost:'0.00000012',base_unit_cost:'1.234567890123'}]},config)
  assert.equal(sale.find(line=>line.account_id==='cogs').debit,1.23)
  const returned=buildReturnPosting({total_refund:'1',sale:{payment_method:{name:'Efectivo'}},return_items:[{...item('P','1','1','1'),restock_qty:'1',base_restock_qty:'1',sale_item:{item_kind:'STANDARD',unit_cost:'7',base_unit_cost:'1.234567890123'}}]},config)
  assert.equal(returned.find(line=>line.account_id==='cogs').credit,1.23)
})

test('inline return posting loads frozen base cost rather than a rounded commercial cost projection',async()=>{
  const {Prisma}=require('@prisma/client'),{withMocks}=require('./helpers/reportHarness.cjs')
  const engine=require.resolve('../src/services/accounting/postingEngine'),core=require.resolve('../src/services/accounting/core'),registry=require.resolve('../src/modules/platform/registry')
  const defaults=Object.fromEntries(['cash','bank','sales','inventory','cogs','receivables','salesReturns','ivaDebit','pequenoTax','pequenoTaxExpense'].map(id=>[id,{id}]))
  let posted
  const db={companyModule:{findMany:async()=>[]},journalEntry:{findFirst:async()=>null},return:{findFirst:async({include})=>({id:'R',total_refund:new Prisma.Decimal(1),sale:{payment_method:{name:'Efectivo'}},return_items:[{unit_metadata_version:2,base_restock_qty:'1',restock_qty:'10000000',sale_item:include.return_items.include.sale_item===true?{item_kind:'STANDARD',base_unit_cost:'1.234567890123',unit_cost:'0.00000012'}:{item_kind:'STANDARD',unit_cost:'0.00000012'}}]})}}
  await withMocks({[registry]:{resolveEffectiveModules:()=>[{code:'accounting',effectiveEnabled:true}]},[core]:{...require(core),lockAccountingCompany:async()=>{},getDefaultAccounts:async()=>defaults,getTaxConfig:async()=>({regime:'PEQUENO',pequenoRate:0}),createEntry:async(_tx,data)=>{posted=data}}},engine,async api=>{
    await api.postReturnInTransaction(db,{companyId:'A',branchId:'B'},'R')
  })
  assert.equal(posted.lines.find(l=>l.account_id==='inventory').debit,1.23)
})

test('purchase and its synthetic payment post the same frozen commercial line total',async()=>{
  const {withMocks}=require('./helpers/reportHarness.cjs'),core=require.resolve('../src/services/accounting/core'),engine=require.resolve('../src/services/accounting/postingEngine')
  const defaults=Object.fromEntries(['cash','bank','sales','inventory','cogs','payables','receivables','salesReturns','ivaDebit','pequenoTax','pequenoTaxExpense'].map(id=>[id,{id}]))
  const entries=[],db={companyModule:{findMany:async()=>[]},systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'})},$queryRaw:async(_parts,...values)=>values.includes('PURCHASE')?[{id:'P'}]:values.includes('PURCHASE_PAYMENT')?[{id:'pm-synth:P'}]:[],$transaction:async run=>run(db),
    incomingMerchandise:{findMany:async()=>[{id:'P',date:new Date(),payment_status:'PAID',items:[{quantity:'3',unit_cost:'0.333333333333',line_total:'1.01'}],paymentEntries:[]}]}}
  for(const key of ['sale','return','incomingMerchandisePaymentEntry','customerPayment','cashClosure'])db[key]={findMany:async()=>[]}
  await withMocks({[core]:{...require(core),getDefaultAccounts:async()=>defaults,getTaxConfig:async()=>({regime:'PEQUENO',pequenoRate:0}),createEntry:async(_tx,data)=>{entries.push(data)}}},engine,async api=>{await api.postPendingOperations(db,'U','A')})
  assert.equal(entries.find(e=>e.source_type==='PURCHASE').lines[0].debit,1.01)
  assert.equal(entries.find(e=>e.source_type==='PURCHASE_PAYMENT').lines[0].debit,1.01)
})

test('a targeted kilogram threshold aggregates gram and kilogram presentations exactly',()=>{
  const reference={version:1,trigger:{id:'KG',code:'KG',family:'MASS',factor:'1'},gift:null}
  const gram={version:2,baseUnit:{id:'G',code:'G',decimals:6},presentation:null,factor:'1'}
  const cart=[{...item('P','0.5','500','10',gram),promotion_base_unit:{id:'G',code:'G',family:'MASS',factor:'0.001'},line_total:'5.00'},
    {...item('P','500','500','0.01',gram),promotion_base_unit:{id:'G',code:'G',family:'MASS',factor:'0.001'},line_total:'5.00'}]
  assert.equal(applyPromotion({type:{name:'MIN_QTY_DISCOUNT'},quantity_reference:reference,min_quantity:'1',discount_percentage:'10',applicable_products:[{product_id:'P'}]},cart).discount,1)
})

test('gift quantity has its own compatible reference instead of inheriting the trigger factor',()=>{
  const reference={version:1,trigger:{id:'KG',code:'KG',family:'MASS',factor:'1'},gift:{id:'ML',code:'ML',family:'VOLUME',factor:'0.001'}}
  const cart=[{...item('A','1','1000','10'),line_total:'10',promotion_base_unit:{id:'G',code:'G',family:'MASS',factor:'0.001'}},
    {...item('B','1','1','20'),line_total:'20',promotion_base_unit:{id:'L',code:'L',family:'VOLUME',factor:'1'}}]
  assert.equal(applyPromotion({type:{name:'FREE_GIFT'},quantity_reference:reference,trigger_product_id:'A',target_product_id:'B',buy_quantity:'1',get_quantity:'250'},cart).discount,5)
})

test('a gift on the trigger product compares kilograms for eligibility and grams only for the gift quantity',()=>{
  const promotion={type:{name:'FREE_GIFT'},trigger_product_id:'P',target_product_id:'P',buy_quantity:'1',get_quantity:'250',quantity_reference:{version:1,trigger:{code:'KG',family:'MASS',factor:'1'},gift:{code:'G',family:'MASS',factor:'0.001'}}}
  const line={...item('P','0.5','0.5','20'),line_total:'10',promotion_base_unit:{code:'KG',family:'MASS',factor:'1'}}
  assert.equal(applyPromotion(promotion,[line]).discount,0)
  assert.equal(applyPromotion(promotion,[line]).freeGift,undefined)
  assert.equal(applyPromotion(promotion,[{...line,qty:'1',base_qty:'1',line_total:'20'}]).discount,5)
})

test('saving measured reference rejects a foreign unit, an incompatible target and ambiguous global scope',async()=>{
  const {resolvePromotionReference}=require('../src/services/units/promotionReference')
  const units={KG:{id:'KG',company_id:'A',code:'KG',family:'MASS',factor:'1'},L:{id:'L',company_id:'A',code:'L',family:'VOLUME',factor:'1'}}
  const tx={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'})},measureUnit:{findFirst:async({where})=>units[where.id]||null},
    product:{findMany:async()=>[{id:'P',kind:'STANDARD',base_unit:units.KG}]}}
  const payload={product_ids:['P'],quantity_reference:{trigger_unit_id:'KG'},min_quantity:'0.5'}
  assert.equal((await resolvePromotionReference(tx,'A',payload,'MIN_QTY_DISCOUNT')).trigger.factor,'1')
  await assert.rejects(resolvePromotionReference(tx,'A',{...payload,quantity_reference:{trigger_unit_id:'FOREIGN'}},'MIN_QTY_DISCOUNT'),e=>e.status===400)
  await assert.rejects(resolvePromotionReference(tx,'A',{...payload,quantity_reference:{trigger_unit_id:'L'}},'MIN_QTY_DISCOUNT'),e=>e.status===400)
  await assert.rejects(resolvePromotionReference(tx,'A',{...payload,applies_to_all:true},'MIN_QTY_DISCOUNT'),e=>e.status===400)
})

test('advanced promotion preview uses the server category rather than dropping or accepting a browser category',async()=>{
  const {withPromotionBaseUnits}=require('../src/services/units/promotionReference')
  const tx={product:{findMany:async()=>[{id:'P',category_id:3,base_unit:{id:'U',code:'UNIT',family:'COUNT',factor:'1'}}]}}
  const cart=await withPromotionBaseUnits(tx,[{...item('P','1','7','10'),category_id:999}], 'A')
  assert.equal(applyPromotion({type:{name:'PERCENTAGE'},discount_percentage:'10',applicable_categories:[{category_id:3}]},cart).discount,1)
  assert.equal(applyPromotion({type:{name:'PERCENTAGE'},discount_percentage:'10',applicable_categories:[{category_id:999}]},cart).discount,0)
})

test('the promotion writer persists a server-owned measured reference and six-decimal threshold',async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  let saved
  const kg={id:'KG',company_id:'A',code:'KG',family:'MASS',factor:'1'}
  const tx={systemSetting:{findUnique:async()=>({key:'inventory_units_enabled',value:'true'})},measureUnit:{findFirst:async()=>kg},promotionType:{findUnique:async()=>({name:'MIN_QTY_DISCOUNT'})},
    product:{findMany:async()=>[{id:'P',kind:'STANDARD',base_unit:kg}]},promotion:{create:async({data})=>{saved={id:'PROMO',...data};return saved},findUnique:async()=>saved},promotionProduct:{createMany:async()=>{}},promotionCode:{findMany:async()=>[],createMany:async()=>{}}}
  tx.$transaction=async run=>run(tx)
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:tx,prismaTransaction:tx}},require.resolve('../src/modules/promotions/controller'),async controller=>{
    const res=jsonResponse()
    await controller.create({companyId:'A',branchId:'B',body:{codes:['KG10'],name:'Medio kilo',type_id:1,discount_percentage:'10',min_quantity:'0.5',product_ids:['P'],quantity_reference:{trigger_unit_id:'KG'}}},res,e=>{throw e})
    assert.equal(res.statusCode,201)
  })
  assert.equal(String(saved.min_quantity),'0.5');assert.equal(saved.quantity_reference.trigger.factor,'1');assert.equal(saved.quantity_reference.trigger.family,'MASS')
})
