const test=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp'),express=require('express')
const {fixture}=require('./helpers/packagesDb')
const image=require('../src/modules/inventory/packages/images')
function storageFixture(){
 const calls=[]
 return {calls,storage:{from(bucket){assert.equal(bucket,'productos');return {async upload(path,buffer,options){calls.push({path,buffer,options});return {data:{path}}},getPublicUrl(path){return {data:{publicUrl:'https://storage.invalid/'+path}}}}}}}
}
const raster=async(format='png')=>sharp({create:{width:8,height:6,channels:3,background:'red'}})[format]().toBuffer()
function pngChunk(type,data){
 const body=Buffer.concat([Buffer.from(type),data]),length=Buffer.alloc(4),checksum=Buffer.alloc(4)
 let crc=0xffffffff
 for(const byte of body){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
 length.writeUInt32BE(data.length);checksum.writeUInt32BE((crc^0xffffffff)>>>0)
 return Buffer.concat([length,body,checksum])
}
async function pngWithChunks(animated){
 const png=await raster(),chunks=[];let header;const idat=[]
 for(let offset=8;offset<png.length;){const length=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8),data=png.subarray(offset+8,offset+8+length);if(type==='IHDR')header=data;if(type==='IDAT')idat.push(data);offset+=length+12}
 chunks.push(png.subarray(0,8),pngChunk('IHDR',header))
 if(animated){
  const animation=Buffer.alloc(8);animation.writeUInt32BE(2)
  const frame=sequence=>{const data=Buffer.alloc(26);data.writeUInt32BE(sequence);data.writeUInt32BE(8,4);data.writeUInt32BE(6,8);data.writeUInt16BE(100,20);data.writeUInt16BE(1000,22);return pngChunk('fcTL',data)}
  const sequence=Buffer.alloc(4);sequence.writeUInt32BE(2)
  chunks.push(pngChunk('acTL',animation),frame(0),pngChunk('IDAT',Buffer.concat(idat)),frame(1),pngChunk('fdAT',Buffer.concat([sequence,...idat])))
 }else chunks.push(pngChunk('tEXt',Buffer.from('Comment\0acTL fcTL fdAT are text here')),pngChunk('IDAT',Buffer.concat(idat)))
 return Buffer.concat([...chunks,pngChunk('IEND',Buffer.alloc(0))])
}
test('APNG is rejected before storage even when decoder metadata omits animation pages',async()=>{
 const buffer=await pngWithChunks(true),metadata=await sharp(buffer).metadata(),s=storageFixture()
 assert.equal(metadata.format,'png');assert.equal(metadata.pages,undefined)
 await assert.rejects(image.storePackageImage(fixture().scope.companyId,{buffer,mimetype:'image/png'},{storage:s.storage}),{status:400})
 assert.equal(s.calls.length,0)
})
test('static PNG containing animation chunk names in text remains accepted',async()=>{
 const s=storageFixture();await image.storePackageImage(fixture().scope.companyId,{buffer:await pngWithChunks(false),mimetype:'image/png'},{storage:s.storage});assert.equal(s.calls.length,1)
})
test('package images are decoded, normalized and stored only under the company prefix',async()=>{
 for(const [format,mimetype] of [['png','image/png'],['jpeg','image/jpeg'],['webp','image/webp']]){
  const f=fixture(),s=storageFixture(),result=await image.storePackageImage(f.scope.companyId,{buffer:await raster(format),mimetype,originalname:'../../secret.svg'},{storage:s.storage})
  assert.equal(s.calls.length,1);const call=s.calls[0]
  assert.match(call.path,new RegExp('^'+f.scope.companyId+'/packages/[a-f0-9-]+\\.webp$'));assert.equal(call.options.upsert,false);assert.equal(call.options.contentType,'image/webp')
  const metadata=await sharp(call.buffer).metadata();assert.equal(metadata.format,'webp');assert.equal(metadata.exif,undefined);assert.equal(result.imageUrl,'https://storage.invalid/'+call.path)
 }
})
test('package image rejects spoofed, corrupt, animated, oversized and excessive-pixel inputs before storage',async()=>{
 const animated=await sharp(Buffer.from([255,0,0,255,0,0,255,0,0,255,0,0,0,0,255,0,0,255,0,0,255,0,0,255]),{raw:{width:2,height:4,channels:3,pageHeight:2}}).webp({loop:0,delay:[100,100]}).toBuffer()
 assert.equal((await sharp(animated).metadata()).pages,2)
 const large=await sharp({create:{width:5000,height:5000,channels:3,background:'white'}}).png().toBuffer()
 for(const file of [{buffer:await raster(),mimetype:'image/jpeg'},{buffer:Buffer.from('<svg/>'),mimetype:'image/svg+xml'},{buffer:Buffer.from('garbage'),mimetype:'image/png'},{buffer:animated,mimetype:'image/webp'},{buffer:Buffer.alloc(5*1024*1024+1),mimetype:'image/png'},{buffer:large,mimetype:'image/png'}]){
  const s=storageFixture();await assert.rejects(image.storePackageImage(fixture().scope.companyId,file,{storage:s.storage}),e=>[400,413].includes(e.status));assert.equal(s.calls.length,0)
 }
})
test('image storage errors never expose provider or configuration details',async()=>{
 await assert.rejects(image.storePackageImage(fixture().scope.companyId,{buffer:await raster(),mimetype:'image/png'},{storage:{from(){throw Error('SECRET_KEY')}}}),e=>e.status===503&&!e.message.includes('SECRET'))
})
test('package image endpoint authorizes before parsing multipart and respects company, branch and module',async t=>{
 const f=fixture(),s=storageFixture();let scope=f.scope,authenticated=true
 const app=express();app.use('/packages',require('../src/modules/inventory/packages/routes').createPackageRouter({db:f.db,scope:()=>scope,storage:s.storage,auth:(_req,res,next)=>authenticated?next():res.status(401).end()}))
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)))
 const send=async({huge=false}={})=>{const body=new FormData();body.append('image',new Blob([huge?Buffer.alloc(5*1024*1024+1):await raster()],{type:'image/png'}),'photo.png');return fetch('http://127.0.0.1:'+server.address().port+'/packages/images',{method:'POST',body})}
 authenticated=false;assert.equal((await send()).status,401);authenticated=true
 for(const [patch,status] of [[{companyId:null},403],[{permissions:['products.view']},403],[{branchId:null},400],[{branchId:'00000000-0000-4000-8000-000000009999'},403]]){
  scope={...f.scope,...patch};assert.equal((await send({huge:true})).status,status)
 }
 scope=f.scope;f.state.modules.push({company_id:scope.companyId,module_code:'inventory',status:'DISABLED'});assert.equal((await send()).status,403);f.state.modules=[]
 assert.equal(s.calls.length,0)
 assert.equal((await send({huge:true})).status,413);assert.equal(s.calls.length,0)
 const valid=await send(),result=await valid.json();assert.equal(valid.status,201,JSON.stringify(result));assert.equal(valid.headers.get('cache-control'),'no-store');assert.match(result.imageUrl,/\/packages\//);assert.equal(s.calls.length,1)
})
