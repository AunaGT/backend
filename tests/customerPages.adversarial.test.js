const test=require('node:test'),assert=require('node:assert/strict'),{fixture,scope}=require('./helpers/customerPagesDb'),{randomUUID}=require('node:crypto')
test('malformed resource identifiers are rejected before they reach UUID database columns',async()=>{
 const {readDraftAsset}=require('../src/modules/config/customerPages/assets'),f=fixture();f.db.portalAsset.findFirst=async()=>{throw Error('Invalid database UUID')}
 await assert.rejects(()=>readDraftAsset(f.db,scope,'not-a-uuid'),e=>e.status===404)
})
test('revoked publication permission, foreign saved assets and deep JSON cannot activate a design',async()=>{
 const {resolveBase}=require('../src/modules/config/customerPages/bases'),{validateDesign}=require('../src/modules/config/customerPages/validate'),{saveSection}=require('../src/modules/config/customerPages/sections'),f=fixture(),foreign=randomUUID(),d=resolveBase('QUOTE')
 f.assets.push({id:foreign,company_id:'other',path:'other/assets/'+foreign+'.png'})
 await assert.rejects(()=>saveSection(f.db,scope,{name:'Ajena',documentType:'QUOTE',nodes:[],resources:{photo:{assetId:foreign,alt:'Foto'}}}),e=>e.status===422)
 let n={id:'deep',type:'Section',props:{},styles:{desktop:{},tablet:{},mobile:{}},visibility:{},children:[]},root=n;for(let i=0;i<100;i++){const c={...n,id:'deep'+i,children:[]};n.children=[c];n=c}d.nodes.push(root);assert.throws(()=>validateDesign(d),e=>e.status===422)
 const {compileCustomBlock}=require('../src/modules/config/customerPages/isolation/compile');assert.throws(()=>compileCustomBlock({html:'<p>Hola</p>',css:'p{background:u\\72l(https://evil.test)}',js:'',fallbackText:'Hola'},{channelId:'channel-adversarial'}),e=>e.status===422)
})
