function isCashMethod(method,legacyPredicate) {
  if(!method) return false
  if(method.settlement_kind!=null) return method.settlement_kind==='CASH'
  return legacyPredicate(String(method.name||''))
}
module.exports={isCashMethod}
