const fail=(status,message)=>{throw Object.assign(Error(message),{status})}
async function findCountScan(db,scope,id,code){
 if(!scope.companyId||!scope.branchId||scope.branchId==='all')fail(400,'Selecciona una sucursal')
 if(typeof code!=='string'||!code.length||code.length>100||/[\x00-\x1f\x7f]/.test(code))fail(400,'Código inválido')
 const session=await db.inventoryCountSession.findFirst({where:{id,branch_id:scope.branchId,branch:{company_id:scope.companyId}},select:{id:true,status:true}})
 if(!session)fail(404,'Sesión no encontrada')
 if(session.status!=='IN_PROGRESS')fail(409,'Esta sesión no está habilitada para contar')
 const registered=await db.productBarcode.findFirst({where:{company_id:scope.companyId,code,active:true},select:{product_id:true}})
 const rows=await db.inventoryCountLine.findMany({where:{session_id:id,OR:[{product:{barcode:code}},...(registered?[{product_id:registered.product_id}]:[])]},take:101,orderBy:{id:'asc'},select:{id:true,product:{select:{name:true}},location:{select:{code:true,warehouse:{select:{name:true}}}}}})
 if(!rows.length)fail(404,'Este producto no pertenece a la sesión de inventariado')
 if(rows.length>100)fail(409,'Hay demasiadas ubicaciones para este código. Localiza su ubicación con los filtros.')
 return rows.map(r=>({lineId:r.id,name:r.product.name,location:`${r.location.warehouse.name} · ${r.location.code}`}))
}
module.exports={findCountScan}
