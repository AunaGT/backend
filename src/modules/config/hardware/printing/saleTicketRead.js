async function readSaleTicket(db,scope,id){
 const [row]=await db.$queryRaw`
  SELECT s.*,to_jsonb(pm) AS payment_method,to_jsonb(st) AS status,
   CASE WHEN cs.id IS NULL THEN NULL ELSE jsonb_build_object('cash_register_id',cs.cash_register_id) END AS "cashRegisterSession",
   jsonb_build_object('name',cashier.name) AS "createdBy",
   COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'item_name',COALESCE(NULLIF(i.item_name,''),p.name),'unit_label',i.unit_label,
    'qty',i.qty::text,'price',i.price::text,'net_total',i.net_total::text,
    'unit_metadata_version',i.unit_metadata_version,'unit_snapshot',i.unit_snapshot,
    'base_qty',i.base_qty::text,'item_kind',i.item_kind,'quantity_decimals',i.quantity_decimals
   ) ORDER BY i.id) FROM sale_items i LEFT JOIN products p ON p.id=i.product_id WHERE i.sale_id=s.id),'[]'::jsonb) AS sale_items,
   COALESCE((SELECT jsonb_agg(to_jsonb(d)||jsonb_build_object(
    'created_at',d.created_at AT TIME ZONE 'UTC','emission_date',d.emission_date AT TIME ZONE 'UTC'
   )) FROM sale_dtes d WHERE d.sale_id=s.id),'[]'::jsonb) AS sale_dtes,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('amount',e.amount::text)) FROM sale_payment_entries e WHERE e.sale_id=s.id),'[]'::jsonb) AS "paymentEntries",
   COALESCE((SELECT jsonb_object_agg(cfg.key,cfg.value) FROM system_settings cfg
    WHERE cfg.company_id=b.company_id AND cfg.key IN ('company_name','company_nit','company_logo_url','locale','currency_code')),'{}'::jsonb) AS _ticket_settings,
   c.name AS _ticket_company_name
  FROM sales s JOIN branches b ON b.id=s.branch_id JOIN companies c ON c.id=b.company_id
  LEFT JOIN payment_methods pm ON pm.id=s.payment_method_id
  LEFT JOIN sale_statuses st ON st.id=s.status_id
  LEFT JOIN cash_register_sessions cs ON cs.id=s.cash_register_session_id
  LEFT JOIN users cashier ON cashier.id=s.created_by
  WHERE s.id=${id}::uuid AND s.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid`
 return row||null
}
module.exports={readSaleTicket}
