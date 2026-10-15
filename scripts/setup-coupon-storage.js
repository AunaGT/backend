require('dotenv').config()
const {assertSupabase}=require('../src/services/supabaseStorage')
async function setupCouponStorage(){
  const storage=assertSupabase().storage
  const {data,error}=await storage.listBuckets();if(error)throw Error('No se pudieron consultar los buckets')
  const found=data.find(b=>b.id==='promotion-coupons')
  if(found?.public)throw Error('promotion-coupons es público. Se requiere dirección del usuario antes de cambiarlo.')
  if(found)return console.log('promotion-coupons ya existe y es privado')
  const result=await storage.createBucket('promotion-coupons',{public:false,fileSizeLimit:5*1024*1024,allowedMimeTypes:['image/webp']})
  if(result.error)throw Error('No se pudo crear promotion-coupons')
  console.log('promotion-coupons creado privado; no se modificaron otros buckets')
}
if(require.main===module)setupCouponStorage().catch(e=>{console.error(e.message);process.exitCode=1})
module.exports={setupCouponStorage}
