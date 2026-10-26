const { returnFiscalStatus } = require('./domain')

function presentReturnDetail(record, users = []) {
  const byId = new Map(users.map((user) => [String(user.id), user]))
  const actor = (id) => id ? byId.get(String(id)) || { id, name: null, email: null } : null
  return {
    ...record,
    ...(Array.isArray(record.return_items)?{return_items:record.return_items.map(item=>({...item,
      ...((item.sale_item??record.sale?.sale_items?.find(line=>Number(line.id)===Number(item.sale_item_id)))?.package_component_key?
        {packageComponentKey:(item.sale_item??record.sale.sale_items.find(line=>Number(line.id)===Number(item.sale_item_id))).package_component_key}:{})}))}:{}),
    actors: {
      approved_by: actor(record.approved_by),
      processed_by: actor(record.processed_by),
      policy_overridden_by: actor(record.policy_overridden_by),
    },
    fiscal: returnFiscalStatus(record.sale?.sale_dtes),
  }
}

module.exports = { presentReturnDetail }
