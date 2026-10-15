async function seedCompanyPaymentMethods(tx,companyId) {
  if(typeof companyId!=='string'||!companyId.trim()) throw Object.assign(new Error('Empresa requerida'),{status:403})
  const methods=await tx.paymentMethod.findMany({where:{company_id:null,base_code:{in:['CASH','CARD','TRANSFER','CREDIT']}},orderBy:{id:'asc'}})
  if(methods.length!==4) throw Object.assign(new Error('Inicializa los métodos de pago básicos'),{status:409,code:'PM_SETUP_REQUIRED'})
  await tx.companyPaymentMethod.createMany({data:methods.map((m,position)=>({company_id:companyId,payment_method_id:m.id,enabled:true,position})),skipDuplicates:true})
}
module.exports={seedCompanyPaymentMethods}
