const {cleanupCouponAssets}=require('../modules/promotions/couponAssets')
function startCouponAssetCleanup(){
  if(process.env.NODE_ENV==='test')return
  let running=false
  const tick=async()=>{if(running)return;running=true;try{await cleanupCouponAssets({limit:50})}catch{console.warn('[coupon-assets] Limpieza no disponible')}finally{running=false}}
  const timer=setInterval(tick,3600000);timer.unref();return timer
}
module.exports={startCouponAssetCleanup}
