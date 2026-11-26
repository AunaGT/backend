const {prisma,prismaTransaction}=require('../../models/prisma')
const {requireBranch,requireCompany,hasPerm}=require('../../middlewares/tenant')
const api=require('./manualSales')
function scope(req){return{companyId:requireCompany(req),branchId:requireBranch(req),userId:req.user.sub,permissions:req.user.permissions||[],isAdmin:hasPerm({...req.user,permissions:[]},'sales.create')}}
exports.packageList=async(req,res,next)=>{try{res.set('Cache-Control','private, no-store');res.json(await require('./packageSales').listSalePackages(prisma,scope(req),req.query))}catch(e){next(e)}}
exports.packageDetail=async(req,res,next)=>{try{res.set('Cache-Control','private, no-store');res.json(await require('./packageSales').getSalePackage(prisma,scope(req),req.params.packageId))}catch(e){next(e)}}
exports.packagePreview=async(req,res,next)=>{try{
 res.set('Cache-Control','private, no-store')
 require('../inventory/units/access').objectInput(req.body,['packages'])
 const result=await prismaTransaction.$transaction(tx=>require('./packageSales').resolveSalePackages(tx,scope(req),req.body.packages,{allowIncomplete:true}),{timeout:30000})
 res.json({packageGroups:require('../../services/commercialPackages').publicPackageGroups(result.groups),subtotal:result.subtotal,issues:result.issues})
}catch(e){next(e)}}
exports.read=async(req,res,next)=>{try{res.json(await api.readManualSale(prisma,scope(req),req.params.id))}catch(e){next(e)}}
exports.preview=async(req,res,next)=>{try{res.json(await api.previewManualSale(prismaTransaction,scope(req),req.body))}catch(e){next(e)}}
exports.save=async(req,res,next)=>{try{res.json(await api.saveManualSale(prismaTransaction,scope(req),req.params.id||null,req.body))}catch(e){next(e)}}
exports.confirm=async(req,res,next)=>{try{res.json(await api.confirmManualSale(prismaTransaction,scope(req),req.params.id,req.body))}catch(e){next(e)}}
exports.cancel=async(req,res,next)=>{try{res.json(await api.cancelManualSale(prismaTransaction,scope(req),req.params.id,req.body))}catch(e){next(e)}}
