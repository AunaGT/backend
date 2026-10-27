const catalog=require('./catalog')
function requestScope(req) {
  const {requestUnitScope}=require('../units/access')
  return{...requestUnitScope(req),branchIds:req.userBranchIds??req.branchIds??(req.branchId?[req.branchId]:[])}
}
function createPackageHandlers({db,scope=requestScope}={}) {
  const handle=(method,{write=false,create=false}={})=>async(req,res,next)=>{
    try{
      const client=db??require('../../../models/prisma')[write?'prismaTransaction':'prisma'],context=scope(req)
      let result
      if(method==='listPackages')result=await catalog[method](client,context,{...req.query})
      else if(method==='getPackage')result=await catalog[method](client,context,req.params.id)
      else result=await catalog[method](client,context,req.params.id??null,req.body)
      res.status(create?201:200).json(result)
    }catch(error){
      if(['P2021','P2022'].includes(error.code))return res.status(503).json({code:'PACKAGES_NOT_READY',message:'La actualización de paquetes aún no está instalada'})
      if(error.status)return res.status(error.status).json({code:error.code??'INVALID_PACKAGE',message:error.message,...(error.fields?{fields:error.fields}:{})})
      next(error)
    }
  }
  return{list:handle('listPackages'),detail:handle('getPackage'),create:handle('savePackage',{write:true,create:true}),
    save:handle('savePackage',{write:true}),activate:handle('activatePackageVersion',{write:true}),archive:handle('archivePackage',{write:true})}
}
module.exports={createPackageHandlers,requestScope}
