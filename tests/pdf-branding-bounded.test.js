const test=require('node:test'),assert=require('node:assert/strict')
const {withMocks}=require('./helpers/reportHarness.cjs')
const target=require.resolve('../src/utils/pdfBranding'),storage=require.resolve('../src/services/supabaseStorage')
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64')
async function run(fetcher,check){
 const original=global.fetch;global.fetch=fetcher
 try{await withMocks({[storage]:{downloadPublicObject:async()=>null,COMPANY_LOGO_BUCKET:'logo'}},target,check)}finally{global.fetch=original}
}
test('bounded logo checks declared size before reading or decoding',async()=>{
 let cancelled=0,reads=0;const control=new AbortController()
 await run(async(_,options)=>{assert.equal(options?.signal,control.signal);return{ok:true,headers:new Headers({'content-length':'2048'}),body:{cancel:async()=>cancelled++},arrayBuffer:async()=>{reads++;return png}}},async api=>{
  assert.equal(await api.fetchLogoForHttp('https://example.test/oversized.png',{signal:control.signal,maxBytes:1024}),null)
 });assert.equal(cancelled,1);assert.equal(reads,0)
})
test('bounded chunked logo cancels when bytes cross the limit without draining the body',async()=>{
 let reads=0,cancelled=0
 await run(async()=>({ok:true,headers:new Headers(),body:{getReader:()=>({read:async()=>{reads++;return{done:false,value:Buffer.alloc(600)}},cancel:async()=>cancelled++,releaseLock(){}})},arrayBuffer:async()=>png}),async api=>{
  assert.equal(await api.fetchLogoForHttp('https://example.test/chunked.png',{signal:new AbortController().signal,maxBytes:1024}),null)
 });assert.equal(reads,2);assert.equal(cancelled,1)
})
test('bounded logo aborts stalled download and does not cache aborted work',async()=>{
 const control=new AbortController();let calls=0
 await run(async(_,options)=>{calls++;assert.equal(options?.signal,control.signal);control.abort();throw Object.assign(Error('aborted'),{name:'AbortError'})},async api=>{
  assert.equal(await api.fetchLogoForHttp('https://example.test/aborted.png',{signal:control.signal,maxBytes:1024}),null)
  assert.equal(await api.fetchLogoForHttp('https://example.test/aborted.png',{signal:control.signal,maxBytes:1024}),null)
 });assert.equal(calls,1)
})
test('bounded valid logo is rasterized and cached only within the byte limit',async()=>{
 let calls=0
 await run(async()=>{calls++;return new Response(png,{headers:{'content-type':'image/png'}})},async api=>{
  const opts={signal:new AbortController().signal,maxBytes:1024},url='https://example.test/valid.png'
  const result=await api.fetchLogoForHttp(url,opts);assert(result?.buffer.length>0);assert(result.buffer.length<=1024);assert.equal(result.contentType,'image/png')
  assert.deepEqual(await api.fetchLogoForHttp(url,opts),result)
 });assert.equal(calls,1)
})
test('cancellation interrupts a delayed body read and releases its reader',async()=>{
 const control=new AbortController();let started,signal,released=0
 const reading=new Promise(resolve=>started=resolve)
 await run(async(_,options)=>{signal=options?.signal;return{ok:true,headers:new Headers(),body:{getReader:()=>({
  read:()=>new Promise((resolve,reject)=>{started();signal?.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true})}),releaseLock(){released++},
 })},arrayBuffer:async()=>png}},async api=>{
  const result=api.fetchLogoForHttp('https://example.test/delayed.png',{signal:control.signal,maxBytes:1024})
  assert.equal(signal,control.signal);await reading;control.abort();assert.equal(await result,null)
 });assert.equal(released,1)
})
