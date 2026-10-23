const {performance}=require('node:perf_hooks')

function parseArgs(args){
 const options={samples:5,connectionLimit:1},seen=new Set()
 for(const arg of args){
  const match=/^--(samples|connection-limit)=(\d+)$/.exec(arg)
  if(!match||seen.has(match[1]))throw Error('Parámetros inválidos')
  seen.add(match[1]);const value=Number(match[2]),key=match[1]==='samples'?'samples':'connectionLimit'
  if(!Number.isSafeInteger(value)||value<1||value>(key==='samples'?10:2))throw Error('Parámetros inválidos')
  options[key]=value
 }
 return options
}
async function benchmarkConnections({env,options,PrismaClient}){
 const rows=[]
 for(const profile of ['DATABASE_URL','DIRECT_URL']){
  let client
  try{
   if(!env[profile]){rows.push({profile,status:'error',code:'PROFILE_UNAVAILABLE'});continue}
   let url
   try{url=new URL(env[profile]);if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname)throw Error()}catch{rows.push({profile,status:'error',code:'CONFIG_INVALID'});continue}
   url.searchParams.set('connection_limit',String(options.connectionLimit));url.searchParams.set('connect_timeout','5');url.searchParams.set('pool_timeout','5')
   const statements={},duration=async run=>{const start=performance.now();await run();return Number((performance.now()-start).toFixed(2))}
   client=new PrismaClient({datasources:{db:{url:url.toString()}},log:[{emit:'event',level:'query'}]})
   client.$on('query',event=>{const first=/^\s*([A-Z]+)/i.exec(event.query)?.[1].toUpperCase(),label=['SELECT','BEGIN','COMMIT','ROLLBACK','DEALLOCATE','SET'].includes(first)?first:'OTHER';statements[label]=(statements[label]??0)+1})
   const coldMs=await duration(()=>client.$queryRawUnsafe('SELECT 1')),warmMs=[]
   for(let i=0;i<options.samples;i++)warmMs.push(await duration(()=>client.$queryRawUnsafe('SELECT 1')))
   const transactionMs=await duration(()=>client.$transaction(async tx=>{await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');await tx.$queryRawUnsafe('SELECT 1')},{maxWait:5000,timeout:5000}))
   const sorted=[...warmMs].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2),medianMs=sorted.length%2?sorted[middle]:Number(((sorted[middle-1]+sorted[middle])/2).toFixed(2))
   rows.push({profile,status:'ok',coldMs,warmMs,medianMs,transactionMs,statements})
  }catch(error){rows.push({profile,status:'error',code:/^P\d{4}$/.test(error?.code)?error.code:'BENCHMARK_FAILED'})}
  finally{if(client)await client.$disconnect().catch(()=>{})}
 }
 return rows
}
if(require.main===module){
 ;(async()=>{
  let options
  try{options=parseArgs(process.argv.slice(2))}catch{console.error('Parámetros inválidos: --samples=1..10 --connection-limit=1..2');process.exitCode=1;return}
  require('../src/config/loadEnv')
  const rows=await benchmarkConnections({env:process.env,options,PrismaClient:require('@prisma/client').PrismaClient})
  console.log(JSON.stringify({connectionLimit:options.connectionLimit,profiles:rows},null,2))
  if(rows.some(row=>row.status==='error'))process.exitCode=1
 })().catch(()=>{console.error('No se pudo completar el diagnóstico');process.exitCode=1})
}
module.exports={parseArgs,benchmarkConnections}
