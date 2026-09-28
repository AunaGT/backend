exports.withStockUnits = (rows, totals) => {
  const stockByLocation = new Map(totals.map((total) => [total.location_id, Number(total._sum.stock || 0)]))
  return rows.map((warehouse) => ({
    ...warehouse,
    stock_units: warehouse.locations.reduce((sum, location) => sum + (stockByLocation.get(location.id) || 0), 0),
  }))
}
