exports.withStockUnits = (rows, totals,{countLines=false}={}) => {
  const stockByLocation = new Map(totals.map((total) => [total.location_id, countLines?total._count.product_id:Number(total._sum.stock || 0)]))
  return rows.map((warehouse) => ({
    ...warehouse,
    ...(countLines?{stock_units:null,stock_lines:warehouse.locations.reduce((sum, location) => sum + (stockByLocation.get(location.id) || 0), 0)}:{stock_units: warehouse.locations.reduce((sum, location) => sum + (stockByLocation.get(location.id) || 0), 0)}),
  }))
}
