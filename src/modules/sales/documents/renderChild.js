// No database credentials or network operations in the PDF process.
const {renderDocument}=require('../../config/documentTemplates/public')
process.once('message',async input=>{
  try {const result=await renderDocument(input);process.send({...result,observedRss:process.memoryUsage().rss},()=>process.disconnect())}
  catch(error){process.send({error:/^[A-Z_0-9]{3,80}$/.test(error.code||'')?error.code:'DOCUMENT_RENDER_FAILED'},()=>process.disconnect())}
})
