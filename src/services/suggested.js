function calculateSuggestedOrder(currentStock, unitsSoldIn14Days, leadTime, bufferDays) {
  const coverageDays = leadTime + bufferDays;
  const dailyRate = Math.max(0, unitsSoldIn14Days) / 14;
  // Out of stock: order enough to cover lead time + buffer (min 1) regardless of velocity
  // In stock: order the projected shortfall
  if (currentStock <= 0) {
    return Math.max(1, Math.ceil(dailyRate * coverageDays));
  }
  return Math.max(0, Math.ceil((dailyRate * coverageDays) - currentStock));
}

module.exports = { calculateSuggestedOrder };