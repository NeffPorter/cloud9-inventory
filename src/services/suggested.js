function calculateSuggestedOrder(currentStock, unitsSoldIn14Days, leadTime, bufferDays, lowStockThreshold = 5) {
  const coverageDays = leadTime + bufferDays;
  const dailyRate = Math.max(0, unitsSoldIn14Days) / 14;
  // At or below low stock threshold: always suggest enough to cover lead + buffer (min 1)
  // Above threshold: order only the projected shortfall
  if (currentStock <= lowStockThreshold) {
    return Math.max(1, Math.ceil(dailyRate * coverageDays));
  }
  return Math.max(0, Math.ceil((dailyRate * coverageDays) - currentStock));
}

module.exports = { calculateSuggestedOrder };