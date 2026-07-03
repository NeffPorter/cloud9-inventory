function calculateSuggestedOrder(currentStock, unitsSoldIn14Days, leadTime, bufferDays, lowStockThreshold = 5) {
  const coverageDays = leadTime + bufferDays;
  const dailyRate = Math.max(0, unitsSoldIn14Days) / 14;
  // At or below low stock threshold:
  //   restock back up to threshold + cover demand during lead time + buffer
  // Above threshold: order only the projected shortfall
  if (currentStock <= lowStockThreshold) {
    const restockToThreshold = Math.max(0, lowStockThreshold - currentStock);
    return Math.max(1, restockToThreshold + Math.ceil(dailyRate * coverageDays));
  }
  return Math.max(0, Math.ceil((dailyRate * coverageDays) - currentStock));
}

module.exports = { calculateSuggestedOrder };