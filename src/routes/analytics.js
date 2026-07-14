const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../lib/supabase');
const { isHim } = require('../lib/roles');

const ALLOWED = ['regional_manager', 'him', 'admin', 'owner', 'media'];

function requireAnalyticsAccess(req, res, next) {
  if (!ALLOWED.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// GET /api/analytics/transactions?store_id=&start=&end=
router.get('/transactions', auth, requireAnalyticsAccess, async (req, res) => {
  try {
    const { store_id, start, end } = req.query;

    // Build date range (default: current month)
    const now = new Date();
    const startDate = start ? new Date(start) : new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate   = end   ? new Date(end)   : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    // Determine which stores to query
    let storeQuery = supabase.from('stores').select('id, name');
    if (!isHim(req.user.role) && req.user.role !== 'media') {
      storeQuery = storeQuery.eq('id', req.user.store_id);
    } else if (store_id) {
      storeQuery = storeQuery.eq('id', store_id);
    }
    const { data: stores } = await storeQuery;
    if (!stores || stores.length === 0) return res.json({ stores: [] });

    const storeIds = stores.map(s => s.id);

    // Fetch sales_log for the date range
    const { data: sales } = await supabase
      .from('sales_log')
      .select('store_id, type, gross, net, tax')
      .in('store_id', storeIds)
      .gte('created_at', startDate.toISOString())
      .lte('created_at', endDate.toISOString());

    // Aggregate per store
    const storeMap = {};
    stores.forEach(s => {
      storeMap[s.id] = { id: s.id, name: s.name, sales: 0, refunds: 0, gross: 0, net: 0 };
    });

    (sales || []).forEach(row => {
      if (!storeMap[row.store_id]) return;
      if (row.type === 'Sale') {
        storeMap[row.store_id].sales++;
        storeMap[row.store_id].gross += row.gross || 0;
        storeMap[row.store_id].net   += row.net   || 0;
      } else if (row.type === 'Refund') {
        storeMap[row.store_id].refunds++;
        storeMap[row.store_id].gross += row.gross || 0;
        storeMap[row.store_id].net   += row.net   || 0;
      }
    });

    res.json({ stores: Object.values(storeMap) });
  } catch (err) {
    console.error('Analytics error:', err.message);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

module.exports = router;
