const {parseCredential,verifySecret,fail}=require('./credentials')
const {credentialUnavailable}=require('./credentialState')
const {loadIntegrationPrincipal,integrationContext}=require('./policy')
async function authenticateIntegration(db,authorization,now=new Date()){
 const match=typeof authorization==='string'&&/^Bearer (\S+)$/.exec(authorization),parsed=match&&parseCredential(match[1])
 if(!parsed)fail(401,'INVALID_KEY')
 const row=await db.integrationCredential.findUnique({where:{public_id:parsed.publicId},include:{branches:{select:{branch_id:true}}}})
 if(!row||!verifySecret(parsed.secret,row.secret_hash)||credentialUnavailable(row,now))fail(401,'INVALID_KEY')
 const principal=await loadIntegrationPrincipal(db,{companyId:row.company_id,ownerId:row.owner_id},now)
 return integrationContext(row,principal)
}
function validateContextHeaders(req,context){
 if(req.query.companyId!==undefined||req.headers['x-company-id']&&req.headers['x-company-id']!==context.companyId)fail(403,'FORBIDDEN')
 const branch=req.query.branchId,header=req.headers['x-branch-id']
 if(header&&(!context.branches.some(b=>b.id===header)||branch&&header!==branch))fail(403,'FORBIDDEN')
 if(branch&&!context.branches.some(b=>b.id===branch))fail(403,'FORBIDDEN')
}
module.exports={authenticateIntegration,validateContextHeaders}
