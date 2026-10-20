const {advancedProduct,fail}=require('./access')
async function assertProductMigrationReady(tx,product){
 if(product.kind==='SERVICE'||!product.base_unit_id||advancedProduct(product))return
 const [row]=await tx.$queryRawUnsafe(`SELECT (
  p.stock<>COALESCE((SELECT SUM(s.stock) FROM public.product_stocks s WHERE s.product_id=p.id),0)
  OR EXISTS(SELECT 1 FROM public.product_stocks s WHERE s.product_id=p.id AND s.stock<>COALESCE((SELECT SUM(l.stock) FROM public.product_stock_locations l JOIN public.stock_locations sl ON sl.id=l.location_id JOIN public.warehouses w ON w.id=sl.warehouse_id WHERE l.product_id=p.id AND w.branch_id=s.branch_id),0))
  OR EXISTS(SELECT 1 FROM public.product_lots l WHERE l.product_id=p.id GROUP BY l.branch_id HAVING SUM(l.qty_remaining)>COALESCE((SELECT s.stock FROM public.product_stocks s WHERE s.product_id=p.id AND s.branch_id=l.branch_id),0))
  OR EXISTS(SELECT 1 FROM public.product_lots l WHERE l.product_id=p.id AND l.location_id IS NOT NULL GROUP BY l.location_id HAVING SUM(l.qty_remaining)>COALESCE((SELECT s.stock FROM public.product_stock_locations s WHERE s.product_id=p.id AND s.location_id=l.location_id),0))
  OR EXISTS(SELECT 1 FROM public.sale_items i WHERE i.product_id=p.id AND i.qty<=0)
 ) AS review_required FROM public.products p WHERE p.id=$1::uuid AND p.company_id=$2::uuid`,product.id,product.company_id)
 if(!row||row.review_required)fail(409,'Revisa las diferencias previas de inventario o cantidades históricas antes de activar presentaciones','UNIT_MIGRATION_REVIEW_REQUIRED')
}
module.exports={assertProductMigrationReady}
