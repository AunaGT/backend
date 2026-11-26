const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),jwt=require('jwt-simple')
const {secret}=require('../src/config/security'),{withMocks}=require('./helpers/reportHarness.cjs')
const cases=[['inventory/products.routes','inventory/products.controller','/P','products.view'],['inventory/stock.routes','inventory/stock.controller','/moves','stock_moves.view'],['inventory-count/routes','inventory-count/controller','/P','inventory_count.view'],['sales/sales.routes','sales/controller','/P','sales.view_detail'],['quotes/routes','quotes/controller','/P','quotes.view'],['orders/routes','orders/controller','/P','orders.view'],['returns/routes','returns/controller','/P','returns.view'],['transfers/routes','transfers/controller','/P','transfers.view'],['appointments/routes','appointments/controller','/entries','appointments.view']]
test('real authenticated private routers project costs for both reads and echoed nested product data',async()=>{
 const terminal=new Proxy({}, {get:()=> (_req,res)=>res.json({price:'10',cost:'4',items:[{qty:'2',unit_cost:'4',unit_snapshot:{assembly:{unit_cost:'4',value:'8'}}}]})})
 for(const [routerPath,controllerPath,path,permission]of cases){
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{}},[require.resolve('../src/modules/'+controllerPath)]:terminal},require.resolve('../src/modules/'+routerPath),async router=>{
   const app=express();let canView=false
   app.use((req,_res,next)=>{const role={id:42,name:'Operador',company_id:'A',permissions:[permission,...(canView?['products.view_costs']:[])].map(code=>({permission:{code}}))};req.companyId='A';req.branchId='B';req.sessionUser={id:'U',role,user_companies:[{company_id:'A',status:'ACTIVE',role}]};next()})
   app.use(router)
   const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))})
   try{
    for(const visible of [false,true]){
     canView=visible
     const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{headers:{authorization:`Bearer ${jwt.encode({sub:'U',exp:Math.floor(Date.now()/1000)+60},secret)}`}})
     assert.equal(response.status,200,routerPath);assert.equal(response.headers.get('cache-control'),'private, no-store')
     const body=await response.json();assert.equal('cost'in body,visible,routerPath);assert.equal('unit_cost'in body.items[0],visible,routerPath);assert.equal('value'in body.items[0].unit_snapshot.assembly,visible,routerPath)
     assert.equal(body.price,'10');assert.equal(body.items[0].qty,'2')
    }
   }finally{await new Promise(resolve=>server.close(resolve))}
  })
 }
})

test('financial responses are not cacheable and financial access does not require catalog cost access', async () => {
 const terminal = new Proxy({}, { get: () => (_req, res) => res.json({ cost: '4', profit: '6' }) })
 for (const [module, path, permission] of [['reports', '/financial', 'reports.view'], ['analytics', '/summary', 'analytics.view']]) {
  await withMocks({
   [require.resolve('../src/models/prisma')]: { prisma: {} },
   // Module availability normally reads the database; authorization stays real.
   [require.resolve('../src/modules/platform/middleware')]: { requireModule: () => (_req, _res, next) => next() },
   [require.resolve('../src/modules/reports/reportFilters')]: { validateReportScope: async () => [] },
   [require.resolve('../src/modules/' + module + '/controller')]: terminal,
  }, require.resolve('../src/modules/' + module + '/routes'), async router => {
   const app = express()
   app.use((req, _res, next) => {
    const role = { id: 42, name: 'Finanzas', company_id: 'A', permissions: [permission, 'reports.financial'].map(code => ({ permission: { code } })) }
    req.companyId = 'A'; req.branchId = 'B'
    req.sessionUser = { id: 'U', role, user_companies: [{ company_id: 'A', status: 'ACTIVE', role }] }
    next()
   })
   app.use(router)
   const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
   try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { authorization: `Bearer ${jwt.encode({ sub: 'U', exp: Math.floor(Date.now()/1000)+60 }, secret)}` } })
    assert.equal(response.status, 200, module)
    assert.deepEqual(await response.json(), { cost: '4', profit: '6' }, module)
    assert.equal(response.headers.get('cache-control'), 'private, no-store', module)
   } finally { await new Promise(resolve => server.close(resolve)) }
  })
 }
})
