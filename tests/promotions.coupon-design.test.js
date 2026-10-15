const {test}=require('node:test')
const assert=require('node:assert/strict')
const {parseCouponDesign,assertCouponRestrictionFields}=require('../src/modules/promotions/couponDesign')
test('legacy null design preserves template compatibility and undefined is not silently accepted',()=>{
  assert.equal(parseCouponDesign(null),null)
  assert.throws(()=>parseCouponDesign(undefined))
})
test('server rejects missing fields for real operational restrictions',()=>{
  const style={font:'NotoSans',fontSize:30,bold:false,color:'#ffffff',align:'left',lineHeight:1.2,padding:0,background:null,borderColor:null,borderWidth:0,radius:0}
  const design={printPreset:'standard',terms:'',background:{kind:'solid',color:'#000000'},elements:['benefit','code'].map(field=>({id:field,kind:'field',field,style,x:.1,y:.1,width:.8,height:.1,visible:true,locked:false,opacity:1}))}
  assert.throws(()=>assertCouponRestrictionFields(design,{end_date:'2026-12-01',min_purchase:100}),/vigencia|validity/)
  assert.doesNotThrow(()=>assertCouponRestrictionFields(null,{end_date:'2026-12-01'}))
})
