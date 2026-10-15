const {test}=require('node:test'),assert=require('node:assert/strict')
const {createCouponApiHarness}=require('./helpers/couponApiHarness.cjs')
test('active-only update preserves saved design and invalid design leaves promotion untouched',async()=>{
  const h=createCouponApiHarness();try{
    h.savedPromotion().coupon_design={previous:true}
    await h.controller.update(h.req({active:false}),h.res,h.next)
    assert.equal(h.getError(),undefined);assert.equal(h.lastWrite().active,false)
    assert.ok(!Object.hasOwn(h.lastWrite(),'coupon_design'));assert.deepEqual(h.savedPromotion().coupon_design,{previous:true})
    await h.controller.update(h.req({coupon_design:{bad:true}}),h.res,h.next)
    assert.equal(h.getError().status,400);assert.deepEqual(h.savedPromotion().coupon_design,{previous:true})
  }finally{h.restore()}
})
test('clearing a non-nullable start date cannot bypass visibility of the date that remains stored',async()=>{
  const h=createCouponApiHarness();try{
    const style={font:'NotoSans',fontSize:30,bold:false,color:'#ffffff',align:'left',lineHeight:1.2,padding:0,background:null,borderColor:null,borderWidth:0,radius:0}
    const design={printPreset:'standard',terms:'',background:{kind:'solid',color:'#0c203a'},elements:['benefit','code'].map((field,i)=>({id:'field-'+field,kind:'field',field,style,x:.05,y:.1+i*.2,width:.9,height:.1,visible:true,locked:false,opacity:1}))}
    h.savedPromotion().coupon_design={previous:true}
    await h.controller.update(h.req({start_date:null,coupon_design:design}),h.res,h.next)
    assert.equal(h.getError()?.status,400)
    assert.deepEqual(h.savedPromotion().coupon_design,{previous:true})
  }finally{h.restore()}
})
