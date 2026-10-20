const {prisma,prismaTransaction}=require('../../../models/prisma')
const {requireCompany,hasPerm}=require('../../../middlewares/tenant')
const service=require('./service')
function scope(req){return{companyId:requireCompany(req),branchId:req.branchId||null,branchIds:req.branchIds||[],actorId:req.user.sub,permissions:req.user.permissions||[],isAdmin:hasPerm({...req.user,permissions:[]},'hardware.view'),isConsolidated:!req.branchId}}
function handler(run,status=200){return async(req,res,next)=>{try{res.status(status).json(await run(req,scope(req)))}catch(e){if(e.status)return res.status(e.status).json({message:e.message,...(e.fields?{fields:e.fields}:{})});next(e)}}}
exports.scope=scope
exports.handler=handler
exports.workspace=handler((r,s)=>service.workspace(prisma,s,r.query))
exports.createWorkstation=handler((r,s)=>service.saveWorkstation(prismaTransaction,s,null,r.body),201)
exports.updateWorkstation=handler((r,s)=>service.saveWorkstation(prismaTransaction,s,r.params.id,r.body))
exports.createDevice=handler((r,s)=>service.saveDevice(prismaTransaction,s,null,r.body),201)
exports.updateDevice=handler((r,s)=>service.saveDevice(prismaTransaction,s,r.params.id,r.body))
exports.assignDevices=handler((r,s)=>service.assignDevices(prismaTransaction,s,r.params.id,r.body))
exports.recordTest=handler((r,s)=>service.recordTest(prismaTransaction,s,r.body),201)
exports.tests=handler((r,s)=>service.history(prisma,s,r.query,true))
exports.history=handler((r,s)=>service.history(prisma,s,r.query))
