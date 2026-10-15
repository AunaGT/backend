const {fail}=require('./domain/validation')
async function lockEngagementQuote(tx,scope,e){
  if(!e.quote_id)return null
  const quotes=require('../quotes')
  await quotes.assertQuoteSourceAccess(tx,scope)
  const quote=await quotes.lockQuote(tx,scope,e.quote_id)
  if(quote.status!=='ACCEPTED'||quote.customer_contact_id!==e.customer_id||!quote.total.eq(e.agreed_total)||quote.lines.length!==e.lines.length||e.lines.some(l=>{
    const current=quote.lines.find(q=>q.id===l.source_line_id)
    return !current||current.product_id!==l.product_id||current.item_kind!==l.item_kind||!current.qty.eq(l.qty)||!current.unit_price.eq(l.unit_price)||!current.line_total.eq(l.line_total)
  }))fail(409,'SOURCE_REVIEW_REQUIRED','La cotización o sus partidas cambiaron; revisa el alcance comercial')
  return quote
}
module.exports={lockEngagementQuote}
