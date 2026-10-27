const v=require('./validation')
function parseAssignmentRequirements(raw=[]){
  if(!Array.isArray(raw)||raw.length>20)v.invalid('assignmentRequirements','Agrega hasta 20 requisitos')
  let bytes
  try{bytes=Buffer.byteLength(JSON.stringify(raw))}catch{v.invalid('assignmentRequirements','Los requisitos no son válidos')}
  if(bytes>65536)v.invalid('assignmentRequirements','Los requisitos superan el tamaño permitido')
  const seen=new Set();let places=0
  const requirements=raw.map((value,index)=>{
    const key=`assignmentRequirements.${index}`,r=v.object(value,['id','kind','name','quantity','optionIds'])
    const id=v.uuid(r.id,`${key}.id`).toLowerCase()
    if(seen.has(id))v.invalid(`${key}.id`,'El requisito está repetido')
    seen.add(id)
    const quantity=v.integer(r.quantity,`${key}.quantity`,1,20);places+=quantity
    if(places>40)v.invalid('assignmentRequirements','Se admiten hasta 40 asignaciones requeridas')
    if(!Array.isArray(r.optionIds)||!r.optionIds.length||r.optionIds.length>100)v.invalid(`${key}.optionIds`,'Selecciona entre 1 y 100 opciones')
    const optionIds=r.optionIds.map(id=>v.uuid(id,`${key}.optionIds`).toLowerCase()).sort()
    if(new Set(optionIds).size!==optionIds.length)v.invalid(`${key}.optionIds`,'No repitas opciones')
    return{id,kind:v.choice(r.kind,`${key}.kind`,['PROVIDER','RESOURCE']),name:v.text(r.name,`${key}.name`,100),quantity,optionIds}
  })
  return requirements.sort((a,b)=>a.id.localeCompare(b.id))
}
function resolveAssignmentRequirements({requirements,candidates,selectedIds,identityById=new Map(),eligibleByRequirement}){
  const byId=new Map(candidates.map(c=>[c.id,c]))
  if(selectedIds&&(new Set(selectedIds).size!==selectedIds.length||selectedIds.some(id=>!byId.has(id))))return null
  const selected=selectedIds?new Set(selectedIds):null
  const ordered=[...requirements].sort((a,b)=>a.id.localeCompare(b.id))
  const seats=ordered.flatMap(r=>Array.from({length:r.quantity},()=>({requirement:r,options:r.optionIds.filter(id=>byId.get(id)?.kind===r.kind&&(!selected||selected.has(id))&&(!eligibleByRequirement||eligibleByRequirement.get(r.id)?.has(id))).sort()})))
  const owners=new Map(),matched=new Map()
  const identity=id=>`${byId.get(id).kind}:${identityById.get(id)??id}`
  function assign(index,visited){
    for(const id of seats[index].options){
      const person=identity(id)
      if(visited.has(person))continue
      visited.add(person)
      const previous=owners.get(person)
      if(previous===undefined||assign(previous,visited)){
        owners.set(person,index);matched.set(index,id);return true
      }
    }
    return false
  }
  for(let i=0;i<seats.length;i++)if(!assign(i,new Set()))return null
  return{assignments:ordered.map(r=>({requirementId:r.id,entityIds:seats.flatMap((seat,i)=>seat.requirement.id===r.id?[matched.get(i)]:[]).sort()})),
    selectedIds:[...new Set(selectedIds??matched.values())].sort()}
}
function publicAssignmentRequirements(requirements){return requirements.map(({name,kind,quantity})=>({name,kind,quantity}))}
function providerIdentityMap(providers){
  return new Map(providers.map(p=>[p.id,p.user_id||p.employee?.user_id?`user:${p.user_id||p.employee.user_id}`:p.employee_id?`employee:${p.employee_id}`:`provider:${p.id}`]))
}
function assertAssignmentRequirements(requirements,{providerIds=[],resourceIds=[],identityById}={}){
  if(!requirements?.length)return
  const candidates=[...providerIds.map(id=>({id,kind:'PROVIDER'})),...resourceIds.map(id=>({id,kind:'RESOURCE'}))]
  if(!resolveAssignmentRequirements({requirements,candidates,selectedIds:[...providerIds,...resourceIds],identityById}))
    v.fail(409,'REQUIREMENTS_INCOMPLETE','Completa el personal y equipo requeridos',{assignmentRequirements:requirements.map(r=>`${r.name}: ${r.quantity}`).join(' · ')})
}
module.exports={parseAssignmentRequirements,resolveAssignmentRequirements,publicAssignmentRequirements,providerIdentityMap,assertAssignmentRequirements}
