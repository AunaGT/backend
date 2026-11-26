const test=require('node:test'),assert=require('node:assert/strict')
const {buildDisputesReport}=require('../src/modules/reports/models/disputes')
const meta={generatedAt:'2026-11-25T12:00:00Z',timezone:'America/Guatemala',currency:'GTQ',generatedBy:'QA',scope:{companyId:'c',label:'Principal',branches:[{id:'b',name:'Principal'}],warehouse:null,location:null},
 period:{mode:'period',start:null,endExclusive:null,label:'Todo'},branding:{companyName:'QA',logoDataUrl:null}}
const row=(id,status,extra={})=>({id,createdAt:'2026-11-20T15:00:00Z',status,providerReference:'CB-'+id,currency:'GTQ',branch:'Principal',customer:'Cliente',method:'Tarjeta',claimed:100,withdrawn:100,recovered:0,fees:0,loss:40,charged:60,credited:0,...extra})
test('the dispute report shows each money dimension separately, with totals and a status summary',()=>{
 const r=buildDisputesReport({rows:[row('aaaaaaaa-1','LOST'),row('bbbbbbbb-2','WON',{withdrawn:0,loss:0,charged:0})],available:true},meta)
 assert.equal(r.id,'disputes')
 assert.deepEqual(r.summary.map(m=>[m.id,m.value]),[['cases',2],['claimed',200],['withdrawn',100],['recovered',0],['loss',40],['charged',60],['credited',0]])
 const detail=r.sections.find(s=>s.id==='detail')
 assert.equal(detail.columns.some(c=>c.id==='branch'),false,'one branch needs no branch column')
 assert.deepEqual(detail.rows.map(x=>x.status),['Perdida','Ganada']);assert.equal(detail.totals.charged,60)
 assert.deepEqual(r.sections.find(s=>s.id==='by-status').rows.map(x=>[x.status,x.count]),[['Ganada',1],['Perdida',1]])
 assert.match(r.notes[0],/no se suman/)
})
test('without the dispute schema the report is empty and says why',()=>{
 const r=buildDisputesReport({rows:[],available:false},meta)
 assert.equal(r.sections[0].rows.length,0);assert.match(r.notes[0],/todavía no están disponibles/)
})
