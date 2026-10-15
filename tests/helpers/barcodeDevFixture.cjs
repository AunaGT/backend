const {withDevDb,devDbEnabled}=require('./salesDevFixture.cjs'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {createLabelTemplate,defaultPaper}=require('../../src/modules/inventory/barcodeLabels/validation')
async function withBarcodeDevFixture(run){return withDevDb(async db=>{
  const companyId=crypto.randomUUID(),branchId=crypto.randomUUID(),userId=crypto.randomUUID(),goodsId=crypto.randomUUID(),secondGoodsId=crypto.randomUUID(),serviceId=crypto.randomUUID()
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auna-barcode-qa-')),ledgerPath=path.join(dir,'ledger.json'),ledger={companyId,branchId,userId,goodsId,secondGoodsId,serviceId,retained:true}
  fs.chmodSync(dir,0o700);fs.writeFileSync(ledgerPath,JSON.stringify(ledger),{mode:0o600})
  const role=await db.role.findFirst({orderBy:{id:'asc'}}),status=await db.stockStatus.findFirst({orderBy:{id:'asc'}})
  if(!role||!status)throw Error('Existing role/status required; no global seed')
  await db.$transaction(async tx=>{
    await tx.company.create({data:{id:companyId,name:`QA Etiquetas ${companyId}`,code:companyId.slice(0,20)}})
    await tx.branch.create({data:{id:branchId,company_id:companyId,name:'QA etiquetas',code:'LABELQA'}})
    await tx.user.create({data:{id:userId,name:'QA etiquetas',email:`${userId}@example.invalid`,password:'not-a-real-login',role_id:role.id}})
    await tx.userCompany.create({data:{company_id:companyId,user_id:userId}});await tx.userBranch.create({data:{branch_id:branchId,user_id:userId}})
    await tx.companyModule.create({data:{company_id:companyId,module_code:'inventory',status:'ACTIVE'}})
    const category=await tx.productCategory.create({data:{company_id:companyId,name:'QA etiquetas'}})
    const supplier=await tx.supplier.create({data:{company_id:companyId,name:'QA proveedor etiquetas',contact:'QA',party_type:'SUPPLIER'}});ledger.supplierId=supplier.id;fs.writeFileSync(ledgerPath,JSON.stringify(ledger),{mode:0o600})
    await tx.product.createMany({data:[{id:goodsId,name:'QA bien etiquetas',kind:'STANDARD',supplier_id:supplier.id,cost:10},{id:secondGoodsId,name:'QA kit etiquetas',kind:'KIT',supplier_id:supplier.id,cost:10},{id:serviceId,name:'QA servicio no imprimir',kind:'SERVICE',service_unit_label:'Hora',cost:0}].map(p=>({...p,company_id:companyId,category_id:category.id,status_id:status.id,price:25}))})
  },{timeout:30000,maxWait:5000})
  const scope={companyId,branchId,branchIds:[branchId],userId,isAdmin:true,permissions:[]}
  const prepareInput=({mode='auto',value}={})=>({requestKey:crypto.randomUUID(),scope:{branchId,inBranch:false},items:[{productId:goodsId,copies:2,expectedBarcode:null,assignment:{mode,...(value?{value}:{})}}],design:createLabelTemplate(),paper:defaultPaper(),confirmAssignments:true})
  try{return await run({db,scope,fixtures:{goodsId,secondGoodsId,serviceId,prepareInput},ledgerPath})}finally{console.log(`Barcode QA ledger: ${ledgerPath}`)}
})}
module.exports={withBarcodeDevFixture,devDbEnabled}
