const {hasPerm}=require('../../middlewares/tenant')
const GENERAL_SETTING_KEYS=Object.freeze([
  'currency_code','currency_name','timezone','company_name','company_logo_url','cash_closure_denominations',
  'company_nit','fel_enabled','company_address','company_municipality','company_department','company_postal_code','establishment_code','vat_affiliation','iva_rate','pequeno_rate',
  'date_format','locale','cash_closure_max_diff_pct','quote_validity_days','order_validity_days','quote_soft_hold_hours',
  'default_experience_profile','sales_allow_credit','sales_show_fiscal_fields','sales_show_channels','inventory_services_enabled','returns.policy',
  'inventory.expiry_alert_policy',
])
function historyKeys(user){return [...GENERAL_SETTING_KEYS,
  ...(hasPerm(user,'accounting.view')?['accounting.defaultAccounts']:[]),
  ...(hasPerm(user,'products.view')?['inventory.barcode_label_layout','inventory.shelf_price_label_layout']:[]),
]}
module.exports={GENERAL_SETTING_KEYS,historyKeys}
