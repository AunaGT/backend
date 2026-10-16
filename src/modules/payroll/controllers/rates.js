const {prisma,prismaTransaction}=require('../../../models/prisma')
const {requireCompany}=require('../../../middlewares/tenant')
const {toUuid}=require('../../hr')
const {requireRatesAccess,resolvePayrollRates,publishPayrollRates,cancelPayrollRates}=require('../../../services/payroll/rateVersions')
const scope=req=>({companyId:requireCompany(req),userId:req.user?.sub})
exports.list=async(req,res,next)=>{try{
  requireRatesAccess(req.user)
  const {companyId}=scope(req)
  const {DateTime}=require('luxon'),today=DateTime.now().setZone('America/Guatemala').toISODate()
  const [items,current]=await Promise.all([prisma.payrollRateVersion.findMany({where:{company_id:companyId},orderBy:[{effective_from:'desc'},{created_at:'desc'}]}),resolvePayrollRates(prisma,companyId,today)])
  res.json({items,current,today})
}catch(e){next(e)}}
exports.publish=async(req,res,next)=>{try{requireRatesAccess(req.user,true);res.status(201).json(await publishPayrollRates(prismaTransaction,scope(req),req.body))}catch(e){next(e)}}
exports.cancel=async(req,res,next)=>{try{requireRatesAccess(req.user,true);res.json(await cancelPayrollRates(prismaTransaction,scope(req),toUuid(req.params.id,'Versión no encontrada'),req.body))}catch(e){next(e)}}
