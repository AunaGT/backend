const {randomUUID}=require('node:crypto')
const {id,definition}=require('./packageFixtures')
function matches(row,where={}) {
  return Object.entries(where).every(([key,want])=>{
    if(key==='OR')return want.some(rule=>matches(row,rule))
    if(key==='AND')return want.every(rule=>matches(row,rule))
    if(key==='branches')return row.branches.some(branch=>matches(branch,want.some))
    if(key==='category')return matches(row.category,want)
    const actual=row[key]
    if(want&&typeof want==='object'&&!Array.isArray(want)){
      if('in'in want)return want.in.includes(actual)
      if('gt'in want)return actual>want.gt
      if('not'in want)return actual!==want.not
      if('contains'in want)return String(actual).toLowerCase().includes(want.contains.toLowerCase())
    }
    return actual===want
  })
}
function fixture() {
  const companyId=id(200),branchId=id(201),actorId=id(202)
  const scope={companyId,branchId,branchIds:[branchId,id(203)],actorId,isAdmin:false,permissions:['products.view','products.edit','products.packages.publish','products.packages.archive']}
  const state={packages:[],versions:[],branches:[],commands:[],modules:[],settings:{currency_code:'GTQ',inventory_services_enabled:'true'},
    companyBranches:[{id:branchId,company_id:companyId,active:true},{id:id(203),company_id:companyId,active:true}],
    products:[20,21,22,23].map(n=>({id:id(n),company_id:companyId,name:`Artículo ${n}`,kind:n===20?'SERVICE':'STANDARD',
      deleted:false,available_for_sale:true,quantity_decimals:0,service_unit_label:n===20?'evento':null,unit_revision:1,unit_metadata_version:1,base_unit_id:null,
      base_unit:null,presentations:[],category:{company_id:companyId,deleted:false}}))}
  const db={}
  const rows=name=>name==='packages'?state.packages.map(row=>({...row,branches:state.branches.filter(b=>b.package_id===row.id)})):state[name]
  const model=name=>({
    count:async({where={}}={})=>rows(name).filter(row=>matches(row,where)).length,
    findMany:async({where={},orderBy,take,skip=0}={})=>{
      let found=rows(name).filter(row=>matches(row,where))
      if(orderBy?.id)found=found.sort((a,b)=>a.id<b.id?-1:1)
      return structuredClone(found.slice(skip,take===undefined?undefined:skip+take))
    },
    findFirst:async({where={}}={})=>structuredClone(rows(name).find(row=>matches(row,where))??null),
    create:async({data})=>{
      const row={id:randomUUID(),created_at:new Date(),updated_at:new Date(),...structuredClone(data)}
      state[name].push(row);return structuredClone(row)
    },
    createMany:async({data})=>{state[name].push(...structuredClone(data));return{count:data.length}},
    updateMany:async({where,data})=>{
      let count=0
      for(const row of state[name])if(matches(row,where)){for(const [key,value]of Object.entries(data))row[key]=value&&typeof value==='object'&&'increment'in value?row[key]+value.increment:structuredClone(value);count++}
      return{count}
    },
    deleteMany:async({where})=>{const previous=state[name];state[name]=previous.filter(row=>!matches(row,where));return{count:previous.length-state[name].length}},
  })
  db.commercialPackage=model('packages');db.commercialPackageVersion=model('versions');db.commercialPackageBranch=model('branches');db.commercialPackageCommand=model('commands')
  db.branch=model('companyBranches');db.product=model('products');db.companyModule=model('modules')
  db.systemSetting={findUnique:async({where})=>{const key=where.company_id_key.key;return where.company_id_key.company_id===companyId&&state.settings[key]!==undefined?{key,value:state.settings[key]}:null}}
  db.$executeRaw=async()=>0
  db.$queryRaw=async()=>[]
  db.$transaction=async fn=>{const before=structuredClone(state);try{return await fn(db)}catch(error){for(const key of Object.keys(state))state[key]=before[key];throw error}}
  const input=()=>({expectedVersion:0,definition:definition(),branchIds:[branchId],idempotencyKey:randomUUID()})
  return{db,state,scope,input}
}
module.exports={fixture}
