const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../lib/supabase');
const { isHim } = require('../lib/roles');
const {
  fetchGoogleInsights, fetchAppleInsights, fetchFacebookInsights,
  fetchInstagramInsights, fetchGoogleReviews, fetchGA4Insights
} = require('../services/platforms');

const ALLOWED = ['regional_manager', 'him', 'admin', 'owner', 'media', 'gm', 'store_user'];

function requireAnalyticsAccess(req, res, next) {
  if (!ALLOWED.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// GET /api/analytics/transactions?store_id=&start=&end=
router.get('/transactions', auth, requireAnalyticsAccess, async (req, res) => {
  try {
    const store_id = effectiveStoreId(req);
    const { start, end } = req.query;
    const now = new Date();
    const startDate = start ? new Date(start) : new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate   = end   ? new Date(end)   : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    let storeQuery = supabase.from('stores').select('id, name');
    if (!isHim(req.user.role) && req.user.role !== 'media') {
      storeQuery = storeQuery.eq('id', req.user.store_id);
    } else if (store_id) {
      storeQuery = storeQuery.eq('id', store_id);
    }
    const { data: stores } = await storeQuery;
    if (!stores || stores.length === 0) return res.json({ stores: [] });

    const storeIds = stores.map(s => s.id);
    const { data: sales } = await supabase
      .from('sales_log')
      .select('store_id, type, gross, net, tax')
      .in('store_id', storeIds)
      .gte('created_at', startDate.toISOString())
      .lte('created_at', endDate.toISOString());

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
    console.error('Analytics/transactions error:', err.message);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// Resolve effective store_id — GM/store_user are always scoped to their own store
function effectiveStoreId(req) {
  if (['gm', 'store_user'].includes(req.user.role)) return req.user.store_id || '';
  return req.query.store_id || '';
}

// Helper: load stores with ALL platform credentials from DB
async function getPlatformStores(storeId) {
  let q = supabase.from('stores').select(
    'id, name, google_location_id, apple_location_id, facebook_page_id, facebook_page_token, ga4_property_id'
  );
  if (storeId) q = q.eq('id', storeId);
  const { data } = await q;
  return data || [];
}

// GET /api/analytics/google
router.get('/google', auth, requireAnalyticsAccess, async (req, res) => {
  try {
    const stores = await getPlatformStores(effectiveStoreId(req));
    res.json(await fetchGoogleInsights(req.query.start, req.query.end, stores));
  } catch (err) { res.status(500).json({ configured: true, error: err.message }); }
});

// GET /api/analytics/apple
router.get('/apple', auth, requireAnalyticsAccess, async (req, res) => {
  try {
    const stores = await getPlatformStores(effectiveStoreId(req));
    res.json(await fetchAppleInsights(req.query.start, req.query.end, stores));
  } catch (err) { res.status(500).json({ configured: true, error: err.message }); }
});

// GET /api/analytics/facebook
router.get('/facebook', auth, requireAnalyticsAccess, async (req, res) => {
  try {
    const stores = await getPlatformStores(effectiveStoreId(req));
    res.json(await fetchFacebookInsights(req.query.start, req.query.end, stores));
  } catch (err) { res.status(500).json({ configured: true, error: err.message }); }
});

// GET /api/analytics/instagram
router.get('/instagram', auth, requireAnalyticsAccess, async (req, res) => {
  try {
    const stores = await getPlatformStores(effectiveStoreId(req));
    res.json(await fetchInstagramInsights(req.query.start, req.query.end, stores));
  } catch (err) { res.status(500).json({ configured: true, error: err.message }); }
});

// GET /api/analytics/google-reviews
router.get('/google-reviews', auth, requireAnalyticsAccess, async (req, res) => {
  try {
    const stores = await getPlatformStores(effectiveStoreId(req));
    res.json(await fetchGoogleReviews(stores));
  } catch (err) { res.status(500).json({ configured: true, error: err.message }); }
});

// GET /api/analytics/ga4
router.get('/ga4', auth, requireAnalyticsAccess, async (req, res) => {
  try {
    const stores = await getPlatformStores(effectiveStoreId(req));
    res.json(await fetchGA4Insights(req.query.start, req.query.end, stores));
  } catch (err) { res.status(500).json({ configured: true, error: err.message }); }
});

// GET /api/analytics/expense-revenue?store_id=&start=&end=
router.get('/expense-revenue', auth, requireAnalyticsAccess, async (req, res) => {
  try {
    const store_id = effectiveStoreId(req);
    const { start, end } = req.query;
    const now = new Date();
    const startDate = start ? new Date(start) : new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate   = end   ? new Date(end)   : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const startStr  = startDate.toISOString().slice(0, 10);
    const endStr    = endDate.toISOString().slice(0, 10);

    let storeQuery = supabase.from('stores').select('id, name');
    if (!isHim(req.user.role) && req.user.role !== 'media') {
      storeQuery = storeQuery.eq('id', req.user.store_id);
    } else if (store_id) {
      storeQuery = storeQuery.eq('id', store_id);
    }
    const { data: stores } = await storeQuery;
    if (!stores || stores.length === 0) return res.json({ stores: [] });

    const storeIds = stores.map(s => s.id);

    // Revenue from sales_log (net of sales, minus net of refunds)
    const { data: sales } = await supabase
      .from('sales_log')
      .select('store_id, type, net')
      .in('store_id', storeIds)
      .gte('created_at', startDate.toISOString())
      .lte('created_at', endDate.toISOString());

    // Expenses
    const { data: expenses } = await supabase
      .from('store_expenses')
      .select('store_id, amount')
      .in('store_id', storeIds)
      .gte('expense_date', startStr)
      .lte('expense_date', endStr);

    const storeMap = {};
    stores.forEach(s => { storeMap[s.id] = { id: s.id, name: s.name, revenue: 0, expenses: 0 }; });

    (sales || []).forEach(row => {
      if (!storeMap[row.store_id]) return;
      const net = row.net || 0;
      storeMap[row.store_id].revenue += row.type === 'Sale' ? net : (row.type === 'Refund' ? -Math.abs(net) : 0);
    });
    (expenses || []).forEach(row => {
      if (storeMap[row.store_id]) storeMap[row.store_id].expenses += row.amount || 0;
    });

    const result = Object.values(storeMap).map(s => ({
      ...s,
      margin: s.revenue - s.expenses,
      marginPct: s.revenue > 0 ? ((s.revenue - s.expenses) / s.revenue * 100).toFixed(1) : '0.0'
    }));

    res.json({ stores: result });
  } catch (err) {
    console.error('Expense-revenue error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
