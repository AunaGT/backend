/** Copyright (c) 2026 Diego Patzán. All Rights Reserved. */
const {prisma,prismaTransaction}=require('../../models/prisma')
const {listPaymentMethodChoices}=require('../../services/paymentMethods/access')
const {listPaymentMethodsCatalog,createCompanyPaymentMethod,updateCompanyPaymentMethod,deleteCompanyPaymentMethod}=require('../../services/paymentMethods/management')
exports.list=async(req,res,next)=>{
  try {
    const q=req.query||{}
    const admin=q.page!=null||q.pageSize!=null||q.search!=null||q.state!=null||q.includeSummary!=null
    res.json(admin?await listPaymentMethodsCatalog(prisma,req.companyId,{...q,includeSummary:q.includeSummary==='true'}):
      await listPaymentMethodChoices(prisma,req.companyId,{includeInactive:q.includeInactive==='1'}))
  }catch(e){next(e)}
}
exports.create=async(req,res,next)=>{try{res.status(201).json(await createCompanyPaymentMethod(prismaTransaction,req.companyId,req.body))}catch(e){next(e)}}
exports.update=async(req,res,next)=>{try{res.json(await updateCompanyPaymentMethod(prismaTransaction,req.companyId,req.params.id,req.body))}catch(e){next(e)}}
exports.remove=async(req,res,next)=>{try{res.json(await deleteCompanyPaymentMethod(prismaTransaction,req.companyId,req.params.id))}catch(e){next(e)}}
