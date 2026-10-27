const v=require('./validation')
const MINUTE=60000
const emptyTimeline=()=>({schemaVersion:1,milestones:[],attendanceWindows:[],requirementWindows:[]})
function parseOperationalTimeline(raw){
 if(raw===undefined)return emptyTimeline()
 let bytes
 try{bytes=Buffer.byteLength(JSON.stringify(raw))}catch{v.invalid('operationalTimeline','El cronograma no es válido')}
 if(bytes>65536)v.invalid('operationalTimeline','El cronograma supera el tamaño permitido')
 const t=v.object(raw,['schemaVersion','milestones','attendanceWindows','requirementWindows'])
 if(t.schemaVersion!==1)v.invalid('operationalTimeline','La versión del cronograma no es compatible')
 const list=(key,max)=>{if(!Array.isArray(t[key])||t[key].length>max)v.invalid('operationalTimeline.'+key,`Agrega hasta ${max} elementos`);return t[key]}
 const unique=(items,key,field)=>{const seen=new Set();for(const item of items){const id=key(item);if(seen.has(id))v.invalid(field,'No repitas el mismo elemento');seen.add(id)}return items}
 const range=(r,key)=>{
  const startOffsetMinutes=v.integer(r.startOffsetMinutes,key+'.startOffsetMinutes',0,44640),endOffsetMinutes=v.integer(r.endOffsetMinutes,key+'.endOffsetMinutes',0,44640)
  if(endOffsetMinutes<=startOffsetMinutes)v.invalid(key+'.endOffsetMinutes','El fin debe ser posterior al inicio')
  return{startOffsetMinutes,endOffsetMinutes}
 }
 const milestones=unique(list('milestones',32).map((item,i)=>{
  const key=`operationalTimeline.milestones.${i}`,r=v.object(item,['id','name','startOffsetMinutes','endOffsetMinutes'])
  return{id:v.uuid(r.id,key+'.id').toLowerCase(),name:v.text(r.name,key+'.name',150),...range(r,key)}
 }),r=>r.id,'operationalTimeline.milestones')
 const attendanceWindows=unique(list('attendanceWindows',100).map((item,i)=>{
  const key=`operationalTimeline.attendanceWindows.${i}`,r=v.object(item,['kind','entityId','startOffsetMinutes','endOffsetMinutes','outboundMinutes','setupMinutes','teardownMinutes','returnMinutes'])
  return{kind:v.choice(r.kind,key+'.kind',['USER','PROVIDER','RESOURCE']),entityId:v.uuid(r.entityId,key+'.entityId').toLowerCase(),...range(r,key),
   ...Object.fromEntries(['outboundMinutes','setupMinutes','teardownMinutes','returnMinutes'].map(field=>[field,v.integer(r[field],key+'.'+field,0,1440)]))}
 }),r=>r.kind+':'+r.entityId,'operationalTimeline.attendanceWindows')
 const requirementWindows=unique(list('requirementWindows',20).map((item,i)=>{
  const key=`operationalTimeline.requirementWindows.${i}`,r=v.object(item,['requirementId','milestoneId'])
  return{requirementId:v.uuid(r.requirementId,key+'.requirementId').toLowerCase(),milestoneId:v.uuid(r.milestoneId,key+'.milestoneId').toLowerCase()}
 }),r=>r.requirementId,'operationalTimeline.requirementWindows')
 return{schemaVersion:1,milestones,attendanceWindows,requirementWindows}
}
const merge=intervals=>{
 const out=[]
 for(const range of [...intervals].sort((a,b)=>a.start-b.start||a.end-b.end)){
  const last=out.at(-1)
  if(last&&last.end>=range.start)last.end=Math.max(last.end,range.end);else out.push({...range})
 }
 return out
}
function projection({timeline,session,identityById=new Map()}){
 const t=parseOperationalTimeline(timeline),start=Date.parse(v.instant(session.startsAt,'startsAt')),end=Date.parse(v.instant(session.endsAt,'endsAt'))
 if(end<=start||end-start>44640*MINUTE)v.invalid('endsAt','Selecciona un intervalo válido de hasta 31 días')
 const margin=(r,key)=>v.integer(r[key]??0,key,0,1440)
 const base={start:start-(margin(session,'outboundMinutes')+margin(session,'setupMinutes'))*MINUTE,end:end+(margin(session,'teardownMinutes')+margin(session,'returnMinutes'))*MINUTE}
 const assigned=[...new Set([session.organizerId,...session.userIds||[]].filter(Boolean))].map(id=>({kind:'USER',id:id.toLowerCase()}))
 for(const [kind,field]of [['PROVIDER','providerIds'],['RESOURCE','resourceIds']])for(const id of session[field]||[])assigned.push({kind,id:id.toLowerCase()})
 const refs=new Set(assigned.map(r=>r.kind+':'+r.id))
 const windows=new Map(t.attendanceWindows.map((w,i)=>{
  const key=`operationalTimeline.attendanceWindows.${i}`
  if(!refs.has(w.kind+':'+w.entityId))v.invalid(key,'Selecciona primero esta persona o equipo en las asignaciones')
  if(w.kind==='USER'&&w.entityId===session.organizerId?.toLowerCase())v.invalid(key,'El responsable permanece asignado durante todo el evento')
  return[w.kind+':'+w.entityId,w]
 }))
 for(const [field,items]of [['milestones',t.milestones],['attendanceWindows',t.attendanceWindows]])for(const [i,item]of items.entries()){
  if(start+item.endOffsetMinutes*MINUTE>end)v.invalid(`operationalTimeline.${field}.${i}.endOffsetMinutes`,'Este horario termina fuera del evento. Ajusta su fin o amplía la duración del evento')
 }
 const groups=new Map(),identities=new Map()
 for(const r of assigned){
  const identity=r.kind==='PROVIDER'?(identityById.get(r.id)||'provider:'+r.id):r.kind.toLowerCase()+':'+r.id
  identities.set(r.kind+':'+r.id,identity)
  if(!groups.has(identity))groups.set(identity,{userIds:new Set(),providerIds:new Set(),resourceIds:new Set(),presence:[],reserved:[]})
  const group=groups.get(identity),w=windows.get(r.kind+':'+r.id),presence=w?{start:start+w.startOffsetMinutes*MINUTE,end:start+w.endOffsetMinutes*MINUTE}:{start,end}
  const reserved=w?{start:presence.start-(w.outboundMinutes+w.setupMinutes)*MINUTE,end:presence.end+(w.teardownMinutes+w.returnMinutes)*MINUTE}:base
  group[r.kind==='USER'?'userIds':r.kind==='PROVIDER'?'providerIds':'resourceIds'].add(r.id)
  if(identity.startsWith('user:'))group.userIds.add(identity.slice(5))
  group.presence.push(presence);group.reserved.push(reserved)
 }
 const blocks=[]
 for(const [,group]of [...groups].sort(([a],[b])=>a.localeCompare(b))){
  group.presence=merge(group.presence);group.reserved=merge(group.reserved)
  const ids=Object.fromEntries(['userIds','providerIds','resourceIds'].map(k=>[k,[...group[k]].sort()]))
  for(const range of group.reserved)blocks.push({...range,...ids})
 }
 return{t,groups,identities,base,start,end,blocks,milestones:t.milestones.map(m=>({...m,startsAt:new Date(start+m.startOffsetMinutes*MINUTE).toISOString(),endsAt:new Date(start+m.endOffsetMinutes*MINUTE).toISOString()}))}
}
function resolveOperationalTimeline(input){
 const {base,blocks,milestones}=projection(input)
 return{occupiedFrom:new Date(Math.min(base.start,...blocks.map(b=>b.start))).toISOString(),occupiedUntil:new Date(Math.max(base.end,...blocks.map(b=>b.end))).toISOString(),blocks,milestones}
}
function requirementEligibility({requirements,...input}){
 const p=projection(input),links=new Map(p.t.requirementWindows.map(r=>[r.requirementId,r.milestoneId]))
 const milestones=new Map(p.milestones.map(m=>[m.id,m])),byId=new Map(requirements.map(r=>[r.id,r]))
 for(const [id,milestoneId]of links)if(byId.get(id)?.attendanceMode!=='INTERVENTION'||!milestones.has(milestoneId))v.invalid('operationalTimeline.requirementWindows','Relaciona cada requisito con un momento válido del evento')
 const contains=(ranges,range)=>ranges.some(w=>w.start<=range.start&&w.end>=range.end)
 return new Map(requirements.map(r=>{
  const milestone=milestones.get(links.get(r.id)),intervention=r.attendanceMode==='INTERVENTION'
  if(intervention&&!milestone)v.invalid('operationalTimeline.requirementWindows','Selecciona en qué momento se necesita: '+r.name)
  const range=intervention?{start:Date.parse(milestone.startsAt),end:Date.parse(milestone.endsAt)}:{start:p.start,end:p.end}
  return[r.id,new Set(r.optionIds.filter(id=>{
   const group=p.groups.get(p.identities.get(r.kind+':'+id))
   return group&&contains(group.presence,range)&&(intervention||contains(group.reserved,p.base))
  }))]
 }))
}
function sessionInput(row){
 const iso=value=>value instanceof Date?value.toISOString():value
 return{startsAt:iso(row.starts_at),endsAt:iso(row.ends_at),organizerId:row.organizer_id,userIds:(row.participants||[]).map(p=>p.user_id).filter(Boolean),
  providerIds:(row.providers||[]).map(p=>p.provider_id),resourceIds:(row.resources||[]).map(r=>r.resource_id),
  outboundMinutes:row.outbound_minutes??0,setupMinutes:row.setup_minutes??row.policy_snapshot?.beforeMinutes??0,
  teardownMinutes:row.teardown_minutes??row.policy_snapshot?.afterMinutes??0,returnMinutes:row.return_minutes??0}
}
function hasTimeline(row){return row.record_type==='ACTIVITY'&&['milestones','attendanceWindows','requirementWindows'].some(key=>row.operational_timeline?.[key]?.length)}
function sessionBlocks(row,identityById){
 if(hasTimeline(row))return resolveOperationalTimeline({timeline:row.operational_timeline,session:sessionInput(row),identityById}).blocks
 const providerIds=(row.providers||[]).map(p=>p.provider_id),linkedUsers=providerIds.map(id=>identityById?.get(id)).filter(identity=>identity?.startsWith('user:')).map(identity=>identity.slice(5))
 return[{start:new Date(row.occupied_from).getTime(),end:new Date(row.occupied_until).getTime(),
  userIds:[...new Set([row.organizer_id,...(row.participants||[]).map(p=>p.user_id),...linkedUsers].filter(Boolean))],providerIds,resourceIds:(row.resources||[]).map(r=>r.resource_id)}]
}
const shareIdentity=(a,b)=>['userIds','providerIds','resourceIds'].some(key=>(a[key]||[]).some(id=>(b[key]||[]).includes(id)))
module.exports={emptyTimeline,parseOperationalTimeline,resolveOperationalTimeline,requirementEligibility,sessionInput,hasTimeline,sessionBlocks,shareIdentity}
