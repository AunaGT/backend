// Explicit read-only integration check against existing development data.
const assert=require('node:assert/strict')
async function main(args){
 assert.deepEqual(args,['--readonly'])
 require('../src/config/loadEnv')
 const {PrismaClient,Prisma}=require('@prisma/client'),db=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL}},log:[]})
 const qualified=value=>value==null||typeof value==='string'&&/(Z|[+-]\d{2}:\d{2})$/.test(value)
 try{
  const sale=await db.sale.findFirst({where:{created_by:{not:null},sale_dtes:{some:{}}},select:{id:true,date:true,created_by:true,branch_id:true,branch:{select:{company_id:true}},sale_items:{select:{qty:true,price:true}},sale_dtes:{select:{id:true,created_at:true,emission_date:true}}},orderBy:{date:'desc'}})
  assert(sale)
  const scope={companyId:sale.branch.company_id,branchId:sale.branch_id},read=require('../src/modules/config/hardware/printing/saleTicketRead').readSaleTicket
  const row=await read(db,scope,sale.id);assert(row.date instanceof Date);assert.equal(row.date.getTime(),sale.date.getTime())
  for(const d of row.sale_dtes){const old=sale.sale_dtes.find(x=>x.id===d.id);for(const key of ['created_at','emission_date']){assert(qualified(d[key]),'Document date must carry its timezone');assert.equal(d[key]==null?null:new Date(d[key]).getTime(),old[key]?.getTime()??null)}}
  assert.equal(row.sale_items.length,sale.sale_items.length)
  assert(row.sale_items.every(i=>typeof i.price==='string'&&typeof i.qty==='string'))
  const totals=items=>items.reduce((sum,i)=>sum.add(new Prisma.Decimal(i.price).mul(i.qty)),new Prisma.Decimal(0))
  assert(totals(row.sale_items).eq(totals(sale.sale_items)))
  assert.equal(await read(db,{...scope,companyId:require('node:crypto').randomUUID()},sale.id),null)
  assert.equal(await read(db,{...scope,branchId:require('node:crypto').randomUUID()},sale.id),null)
  const session=await require('../src/services/sessionSnapshot').readSessionSnapshot(db,{sub:sale.created_by},{includeBranches:true,passwordChangeAction:'Cambio obligatorio de contraseña'})
  for(const member of session.user.user_companies)for(const key of ['created_at','last_access_at'])assert(qualified(member[key]),'Membership date must carry its timezone')
  console.log(JSON.stringify({readOnly:true,dateParity:true,exactPrices:true,foreignScopeDenied:true,nativeRootDates:true}))
 }finally{await db.$disconnect()}
}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(JSON.stringify({code:/^P\d{4}$/.test(e.code||'')?e.code:'READ_ASSERTION_FAILED',location:e.stack?.split('\n').find(line=>line.includes('at main ('))?.trim()}));process.exitCode=1})
