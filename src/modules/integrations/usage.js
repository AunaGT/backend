const {Prisma}=require('@prisma/client')
const {object,fail}=require('./credentials')
const {authorizeManagement}=require('./policy')
const {getCredential}=require('./management')
const periods={'24h':86400000,'7d':7*86400000,'30d':30*86400000}
const routes=['/products','/products/:id','/categories','/prices','/availability','/branches','/quotes','/quotes/:id','/orders','/orders/:id','/quotes/:id/cancel','/orders/:id/cancel','unmatched']
async function getUsageSummary(db,scope,query={},now=new Date()){
 authorizeManagement(scope);object(query,['period','credentialId'])
 const period=query.period??'7d'
 if(typeof period!=='string'||!Object.hasOwn(periods,period))fail(400)
 if(query.credentialId!==undefined)await getCredential(db,scope,query.credentialId,now)
 const from=new Date(now.getTime()-periods[period])
 const rows=await db.$queryRaw(Prisma.sql`
  WITH events AS (
   SELECT CASE WHEN action='CREATE_DRAFT' THEN COALESCE(status,201)
     WHEN action IN ('UPDATE_DRAFT','CANCEL_DRAFT') THEN COALESCE(status,200) ELSE status END AS result,
    CASE WHEN action='CREATE_DRAFT' AND route IS NULL THEN
      CASE metadata->>'type' WHEN 'QUOTE' THEN '/quotes' WHEN 'ORDER' THEN '/orders' ELSE '/other' END
     ELSE route END AS path
   FROM integration_audit_events
   WHERE company_id=${scope.companyId}::uuid
    AND created_at>=(${from}::timestamptz AT TIME ZONE 'UTC') AND created_at<(${now}::timestamptz AT TIME ZONE 'UTC')
    ${query.credentialId?Prisma.sql`AND credential_id=${query.credentialId}::uuid`:Prisma.empty}
    AND action IN ('USE','CREATE_DRAFT','UPDATE_DRAFT','CANCEL_DRAFT')
  ) SELECT CASE WHEN path IN (${Prisma.join(routes)}) THEN path ELSE '/other' END AS route,
    (result/100)::text || 'xx' AS family, COUNT(*) AS count
   FROM events WHERE result BETWEEN 100 AND 599 GROUP BY 1,2`)
 const byStatus=new Map(),byRoute=new Map();let total=0,successful=0,errors=0
 for(const row of rows){
  const count=Number(row.count)
  if(!Number.isSafeInteger(count)||count<0||!Number.isSafeInteger(total+count))fail(503,'UNAVAILABLE')
  const route=routes.includes(row.route)?row.route:'/other'
  if(!/^[1-5]xx$/.test(row.family))fail(503,'UNAVAILABLE')
  total+=count;if(row.family<'4xx')successful+=count;else errors+=count
  byStatus.set(row.family,(byStatus.get(row.family)||0)+count);byRoute.set(route,(byRoute.get(route)||0)+count)
 }
 const ordered=[...byRoute].filter(([r])=>r!=='/other').sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])),shown=ordered.slice(0,10).map(([route,count])=>({route,count}))
 const other=(byRoute.get('/other')||0)+ordered.slice(10).reduce((sum,[,count])=>sum+count,0)
 if(other)shown.push({route:'/other',count:other})
 return{period,from:from.toISOString(),to:now.toISOString(),coverage:'AUTHENTICATED_RECORDED',retentionDays:30,total,successful,errors,errorRate:total?errors/total:null,byStatus:[...byStatus].sort(([a],[b])=>a.localeCompare(b)).map(([family,count])=>({family,count})),byRoute:shown}
}
module.exports={getUsageSummary}
