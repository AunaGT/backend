const permissions=Object.freeze([
  {code:'document_templates.view',name:'Ver plantillas de documentos',description:'Consulta los diseños de documentos de la empresa'},
  {code:'document_templates.manage',name:'Editar plantillas de documentos',description:'Administra apariencia, borradores y recursos; no publica'},
  {code:'document_templates.publish',name:'Publicar plantillas de documentos',description:'Publica diseños validados y establece los predeterminados'},
])
const fail=(status,message,code)=>Object.assign(new Error(message),{status,code})
function authorize(scope,permission='view') {
  if(!scope?.companyId||!scope.actorId)throw fail(400,'Selecciona una empresa')
  const owned=new Set(scope.permissions||[])
  if(!scope.isAdmin&&!owned.has(`document_templates.${permission}`)&&!(permission==='view'&&['manage','publish'].some(p=>owned.has(`document_templates.${p}`))))throw fail(403,'No tienes permiso para esta acción')
  return {company_id:scope.companyId}
}
module.exports={permissions,authorize,fail}
