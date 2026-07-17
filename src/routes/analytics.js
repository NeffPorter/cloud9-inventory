const express = require('express');
const router = express.Router();
const https   = require('https');
const crypto  = require('crypto');
const auth = require('../middleware/auth');
const supabase = require('../lib/supabase');
const { isHim } = require('../lib/roles');
const {
  fetchGoogleInsights, fetchAppleInsights, fetchFacebookInsights,
  fetchInstagramInsights, fetchGoogleReviews, fetchGA4Insights
} = require('../services/platforms');

// In-memory state store for OAuth (expires after 10 min)
const oauthStates = new Map();
function cleanStates() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of oauthStates) if (v.ts < cutoff) oauthStates.delete(k);
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

const ALLOWED = ['regional_manager', 'him', 'admin', 'owner', 'marketing', 'gm', 'store_user'];

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
    if (!isHim(req.user.role) && req.user.role !== 'marketing') {
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

// GET /api/analytics/fb-debug — shows raw token info from Facebook (no auth for debugging)
router.get('/fb-debug', async (req, res) => {
  try {
    const stores = await getPlatformStores('');
    const results = await Promise.all(stores.filter(s => s.facebook_page_id && s.facebook_page_token).map(async s => {
      const https = require('https');
      const token = s.facebook_page_token;
      const pageId = s.facebook_page_id;
      const tokenPreview = token.substring(0, 20) + '...' + token.substring(token.length - 10);

      // Check token info
      const debugUrl = `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`;
      const debugRes = await new Promise((resolve) => {
        https.get(debugUrl, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>resolve(d)); });
      });
      const debugData = JSON.parse(debugRes);

      return {
        store: s.name,
        pageId,
        tokenPreview,
        tokenLength: token.length,
        tokenDebug: debugData.data || debugData.error || debugData
      };
    }));
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    if (!isHim(req.user.role) && req.user.role !== 'marketing') {
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

// GET /api/analytics/fb-auth-url — returns Facebook OAuth URL (requires JWT auth header)
router.get('/fb-auth-url', auth, async (req, res) => {
  if (!isHim(req.user.role)) return res.status(403).json({ error: 'Admin only' });
  cleanStates();
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { ts: Date.now() });
  const appId      = process.env.FB_APP_ID || '3526602337498943';
  const redirectUri = process.env.FB_REDIRECT_URI;
  if (!redirectUri) return res.status(500).json({ error: 'FB_REDIRECT_URI not set in Railway env vars' });
  const scope = 'pages_read_engagement,pages_show_list,business_management,read_insights,public_profile';
  const url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}&response_type=code`;
  res.json({ url });
});

// GET /api/analytics/fb-callback — Facebook redirects here after user authorizes
router.get('/fb-callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/stores?fb=error&msg=${encodeURIComponent(req.query.error_description || error)}`);
  if (!state || !oauthStates.has(state)) return res.redirect('/stores?fb=error&msg=Invalid+or+expired+state');
  oauthStates.delete(state);

  const appId       = process.env.FB_APP_ID || '3526602337498943';
  const appSecret   = process.env.FB_APP_SECRET;
  const redirectUri = process.env.FB_REDIRECT_URI;
  if (!appSecret || !redirectUri) return res.redirect('/stores?fb=error&msg=Server+not+configured');

  try {
    // 1. Exchange code → short-lived user token
    const tokenRes  = await httpsGet(`https://graph.facebook.com/v21.0/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${code}`);
    const tokenData = JSON.parse(tokenRes);
    if (tokenData.error) throw new Error(tokenData.error.message);

    // 2. Exchange short-lived → long-lived user token
    const longRes  = await httpsGet(`https://graph.facebook.com/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${encodeURIComponent(tokenData.access_token)}`);
    const longData = JSON.parse(longRes);
    if (longData.error) throw new Error(longData.error.message);

    // 3. Get all managed pages — page tokens from a long-lived user token never expire
    const accountsRes  = await httpsGet(`https://graph.facebook.com/v21.0/me/accounts?access_token=${encodeURIComponent(longData.access_token)}&limit=50`);
    const accountsData = JSON.parse(accountsRes);
    if (accountsData.error) throw new Error(accountsData.error.message);

    // 4. Match pages to stores by facebook_page_id and save tokens
    const { data: stores } = await supabase.from('stores').select('id, name, facebook_page_id').not('facebook_page_id', 'is', null);
    let updated = 0;
    for (const page of (accountsData.data || [])) {
      const store = (stores || []).find(s => s.facebook_page_id === page.id);
      if (store && page.access_token) {
        await supabase.from('stores').update({ facebook_page_token: page.access_token }).eq('id', store.id);
        updated++;
        console.log(`[FB OAuth] Saved permanent token for ${store.name} (page ${page.id})`);
      }
    }

    res.redirect(`/stores?fb=success&updated=${updated}`);
  } catch (err) {
    console.error('[FB OAuth]', err.message);
    res.redirect(`/stores?fb=error&msg=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
