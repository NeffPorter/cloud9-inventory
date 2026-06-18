function calculateSuggestedOrder(currentStock, unitsSoldIn14Days, leadTime, bufferDays) {
  const coverageDays = leadTime + bufferDays;
  const dailyRate = unitsSoldIn14Days / 14;
  const suggested = Math.ceil((dailyRate * coverageDays) - currentStock);
  return Math.max(0, suggested);
}

module.exports = { calculateSuggestedOrder };