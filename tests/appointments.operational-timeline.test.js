const test=require('node:test'),assert=require('node:assert/strict')
const {parseOperationalTimeline:parse,resolveOperationalTimeline:resolve,requirementEligibility}=require('../src/modules/appointments/domain/operationalTimeline')
const {resolveAssignmentRequirements}=require('../src/modules/appointments/domain/assignmentRequirements')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const empty=()=>({schemaVersion:1,milestones:[],attendanceWindows:[],requirementWindows:[]})
const session=()=>({startsAt:'2026-11-01T18:00:00Z',endsAt:'2026-11-01T22:00:00Z',organizerId:id(1),userIds:[],providerIds:[id(2)],resourceIds:[id(3)],outboundMinutes:30,setupMinutes:15,teardownMinutes:15,returnMinutes:30})
const window=(entityId=id(2),patch={})=>({kind:'PROVIDER',entityId,startOffsetMinutes:60,endOffsetMinutes:90,outboundMinutes:10,setupMinutes:0,teardownMinutes:0,returnMinutes:10,...patch})
const milestone=()=>({id:id(9),name:'Intervención',startOffsetMinutes:60,endOffsetMinutes:90})
const req=(n,mode,options,quantity=1)=>({id:id(n),kind:'PROVIDER',name:'Atención',quantity,optionIds:options,attendanceMode:mode})
test('a moment adds no occupancy and short attendance reserves only its own travel margins',()=>{
 const t={...empty(),milestones:[milestone()],attendanceWindows:[window()]},out=resolve({timeline:t,session:session()})
 assert.equal(out.blocks.length,3)
 const p=out.blocks.find(b=>b.providerIds.includes(id(2))),r=out.blocks.find(b=>b.resourceIds.includes(id(3)))
 assert.equal(new Date(p.start).toISOString(),'2026-11-01T18:50:00.000Z');assert.equal(new Date(p.end).toISOString(),'2026-11-01T19:40:00.000Z')
 assert.equal(new Date(r.start).toISOString(),'2026-11-01T17:15:00.000Z');assert.equal(new Date(r.end).toISOString(),'2026-11-01T22:45:00.000Z')
 assert.equal(out.occupiedFrom,'2026-11-01T17:15:00.000Z');assert.equal(out.occupiedUntil,'2026-11-01T22:45:00.000Z')
 assert.equal(out.milestones[0].startsAt,'2026-11-01T19:00:00.000Z')
 assert.deepEqual(resolve({timeline:empty(),session:session()}).blocks,resolve({session:session()}).blocks)
})
test('organizer aliases keep their full union instead of becoming available under another identity',()=>{
 const out=resolve({timeline:{...empty(),attendanceWindows:[window()]},session:session(),identityById:new Map([[id(2),'user:'+id(1)]])})
 const p=out.blocks.find(b=>b.providerIds.includes(id(2)))
 assert.deepEqual(p.userIds,[id(1)]);assert.equal(new Date(p.start).toISOString(),'2026-11-01T17:15:00.000Z');assert.equal(new Date(p.end).toISOString(),'2026-11-01T22:45:00.000Z')
 assert.throws(()=>resolve({timeline:{...empty(),attendanceWindows:[window(id(1),{kind:'USER'})]},session:session()}),{code:'INVALID_INPUT'})
})
test('matching uses time eligibility without stealing the only intervention candidate',()=>{
 const requirements=[req(10,'FULL',[id(2),id(4)]),req(11,'INTERVENTION',[id(2)])]
 const s={...session(),providerIds:[id(2),id(4)]},t={...empty(),milestones:[milestone()],attendanceWindows:[window()],requirementWindows:[{requirementId:id(11),milestoneId:id(9)}]}
 const eligibleByRequirement=requirementEligibility({requirements,timeline:t,session:s})
 const out=resolveAssignmentRequirements({requirements,candidates:s.providerIds.map(id=>({id,kind:'PROVIDER'})),eligibleByRequirement})
 assert.deepEqual(out.assignments,[{requirementId:id(10),entityIds:[id(4)]},{requirementId:id(11),entityIds:[id(2)]}])
})
test('two consecutive people cannot satisfy two simultaneous places during one whole moment',()=>{
 const requirements=[req(10,'INTERVENTION',[id(2),id(4)],2)],s={...session(),providerIds:[id(2),id(4)]}
 const t={...empty(),milestones:[milestone()],attendanceWindows:[window(id(2),{endOffsetMinutes:75}),window(id(4),{startOffsetMinutes:75})],requirementWindows:[{requirementId:id(10),milestoneId:id(9)}]}
 const eligibleByRequirement=requirementEligibility({requirements,timeline:t,session:s})
 assert.equal(resolveAssignmentRequirements({requirements,candidates:s.providerIds.map(id=>({id,kind:'PROVIDER'})),eligibleByRequirement}),null)
 assert.throws(()=>requirementEligibility({requirements,timeline:empty(),session:s}),{code:'INVALID_INPUT'})
})
test('closed bounded input rejects malformed, duplicated, oversized and unassigned content',()=>{
 const t={...empty(),milestones:[milestone()],attendanceWindows:[window()]}
 for(const raw of [null,[],{...t,script:'bad'},{...t,schemaVersion:2},{...t,milestones:[milestone(),milestone()]},{...t,attendanceWindows:[window(),window()]},
  {...t,milestones:[{...milestone(),startOffsetMinutes:-1}]},{...t,attendanceWindows:[window(id(2),{outboundMinutes:1441})]},
  {...t,attendanceWindows:[window(id(2),{endOffsetMinutes:NaN})]},
  {...t,milestones:Array.from({length:33},(_,i)=>({...milestone(),id:id(100+i)}))},
  {...t,attendanceWindows:Array.from({length:101},(_,i)=>window(id(100+i)))},
  {...t,requirementWindows:Array.from({length:21},(_,i)=>({requirementId:id(100+i),milestoneId:id(9)}))},
  {...t,milestones:[{...milestone(),name:'x'.repeat(65537)}]}])assert.throws(()=>parse(raw),{code:'INVALID_INPUT'})
 assert.throws(()=>resolve({timeline:{...t,attendanceWindows:[window(id(99))]},session:session()}),{code:'INVALID_INPUT'})
 assert.throws(()=>resolve({timeline:{...t,milestones:[{...milestone(),endOffsetMinutes:241}]},session:session()}),{code:'INVALID_INPUT'})
 assert.throws(()=>requirementEligibility({requirements:[],timeline:{...t,requirementWindows:[{requirementId:id(99),milestoneId:id(9)}]},session:session()}),{code:'INVALID_INPUT'})
})
test('elapsed offsets survive midnight and daylight saving folds and move without clipping',()=>{
 const t={...empty(),milestones:[milestone()]}
 const s={...session(),startsAt:'2026-11-01T00:30:00-04:00',endsAt:'2026-11-01T03:30:00-05:00'}
 assert.equal(resolve({timeline:t,session:s}).milestones[0].startsAt,'2026-11-01T05:30:00.000Z')
 const moved={...s,startsAt:'2026-11-02T23:30:00Z',endsAt:'2026-11-03T03:30:00Z'}
 assert.equal(resolve({timeline:t,session:moved}).milestones[0].startsAt,'2026-11-03T00:30:00.000Z')
 assert.throws(()=>resolve({timeline:t,session:{...moved,endsAt:'2026-11-03T00:45:00Z'}}),{code:'INVALID_INPUT'})
})
