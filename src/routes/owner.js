const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../lib/supabase');

const { isOwnerLevel } = require('../lib/roles');

function requireOwner(req, res, next) {
  if (!isOwnerLevel(req.user.role)) return res.status(403).json({ error: 'Owner access required' });
  next();
}

// ── GET /api/owner/inventory-search?q=&store_id= ─────────────────────────────
// Cross-store product search — fuzzy: matches any word across name/group_name/variant_name/category
router.get('/inventory-search', auth, requireOwner, async (req, res) => {
  try {
    const { q, store_id } = req.query;
    if (!q || q.trim().length < 2) return res.json([]);

    const terms = q.trim().split(/\s+/).filter(Boolean);
    const primary = terms[0];

    // Fetch store names separately (avoids FK join issues)
    const { data: storeList } = await supabase.from('stores').select('id, name');
    const storeMap = Object.fromEntries((storeList || []).map(s => [s.id, s.name]));

    let query = supabase
      .from('inventory_items')
      .select('id, store_id, variant_name, group_name, category, price, cost, clover_qty, status')
      .or(`group_name.ilike.%${primary}%,variant_name.ilike.%${primary}%,category.ilike.%${primary}%`)
      .order('group_name');

    if (store_id) query = query.eq('store_id', store_id);

    let { data, error } = await query;
    if (error) throw error;

    // If multi-word query, JS-side filter: each remaining term must appear somewhere
    if (terms.length > 1) {
      data = (data || []).filter(item => {
        const haystack = [item.group_name, item.variant_name, item.category]
          .filter(Boolean).join(' ').toLowerCase();
        return terms.slice(1).every(t => haystack.includes(t.toLowerCase()));
      });
    }

    // Group results by normalized product name (case-insensitive)
    const grouped = {};
    for (const item of data || []) {
      const displayName = item.group_name || item.variant_name || item.id;
      const key = displayName.toLowerCase().trim();
      if (!grouped[key]) grouped[key] = { name: displayName, variants: [] };
      grouped[key].variants.push({
        id: item.id,
        store_id: item.store_id,
        store_name: storeMap[item.store_id] || '—',
        variant_name: item.variant_name,
        category: item.category,
        price: item.price,
        clover_qty: item.clover_qty ?? 0,
        status: item.status
      });
    }

    res.json(Object.values(grouped));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/owner/pl?start=&end=&store_id= ───────────────────────────────────
// P&L data: revenue, COGS (budget invoices), GM expenses, net
router.get('/pl', auth, requireOwner, async (req, res) => {
  try {
    const { start, end, store_id } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end dates required' });

    // Get all stores or specific store
    let storeQuery = supabase.from('stores').select('id, name');
    if (store_id) storeQuery = storeQuery.eq('id', store_id);
    const { data: stores } = await storeQuery;
    if (!stores?.length) return res.json([]);

    const storeIds = stores.map(s => s.id);

    // ── Revenue from sales_log ─────────────────────────────────────────────
    const { data: salesData } = await supabase
      .from('sales_log')
      .select('store_id, net_amount, sale_date')
      .in('store_id', storeIds)
      .gte('sale_date', start)
      .lte('sale_date', end);

    const revenueByStore = {};
    for (const row of salesData || []) {
      revenueByStore[row.store_id] = (revenueByStore[row.store_id] || 0) + parseFloat(row.net_amount || 0);
    }

    // ── COGS: budget invoice totals ────────────────────────────────────────
    // Budgets have a period (month/quarter); use invoice line items with dates in range
    const { data: invoiceItems } = await supabase
      .from('budget_items')
      .select('amount, budgets(store_id, period_start, period_end)')
      .in('budgets.store_id', storeIds);

    // Also check budget_invoices if that table exists (from budget-view invoices)
    const { data: invoices } = await supabase
      .from('budget_invoices')
      .select('amount, store_id, invoice_date, budgets(store_id)')
      .in('store_id', storeIds)
      .gte('invoice_date', start)
      .lte('invoice_date', end)
      .catch(() => ({ data: null }));

    const cogsByStore = {};
    for (const inv of invoices || []) {
      const sid = inv.store_id;
      cogsByStore[sid] = (cogsByStore[sid] || 0) + parseFloat(inv.amount || 0);
    }

    // ── GM Expenses ────────────────────────────────────────────────────────
    const { data: expenses } = await supabase
      .from('store_expenses')
      .select('store_id, amount, category')
      .in('store_id', storeIds)
      .gte('expense_date', start)
      .lte('expense_date', end);

    const expensesByStore = {};
    const expenseCategoryByStore = {};
    for (const exp of expenses || []) {
      expensesByStore[exp.store_id] = (expensesByStore[exp.store_id] || 0) + parseFloat(exp.amount);
      if (!expenseCategoryByStore[exp.store_id]) expenseCategoryByStore[exp.store_id] = {};
      expenseCategoryByStore[exp.store_id][exp.category] =
        (expenseCategoryByStore[exp.store_id][exp.category] || 0) + parseFloat(exp.amount);
    }

    // ── Stocktake shortages (potentially stolen/lost) ─────────────────────
    // Find the most recent completed stocktake per store within or just before the period
    const { data: stocktakes } = await supabase
      .from('stock_take_reports')
      .select('id, store_id, discrepancies, created_at')
      .in('store_id', storeIds)
      .lte('created_at', end + 'T23:59:59')
      .order('created_at', { ascending: false });

    // For each store, use the most recent stocktake in or before the period
    const shortagesByStore = {};
    const seenStores = new Set();
    for (const st of stocktakes || []) {
      if (seenStores.has(st.store_id)) continue;
      seenStores.add(st.store_id);
      const discrepancies = st.discrepancies || [];
      let totalItems = 0;
      let totalValue = 0;
      for (const d of discrepancies) {
        if (d.diff < 0) { // shortage = potentially lost/stolen
          totalItems += Math.abs(d.diff);
          const price = parseFloat(d.item?.price || d.price || 0);
          totalValue += Math.abs(d.diff) * price;
        }
      }
      shortagesByStore[st.store_id] = { items: totalItems, value: totalValue, stocktake_date: st.created_at?.slice(0, 10) };
    }

    // ── Assemble P&L per store ─────────────────────────────────────────────
    const result = stores.map(store => {
      const revenue = revenueByStore[store.id] || 0;
      const cogs = cogsByStore[store.id] || 0;
      const gmExpenses = expensesByStore[store.id] || 0;
      const grossProfit = revenue - cogs;
      const netProfit = grossProfit - gmExpenses;
      const margin = revenue > 0 ? ((netProfit / revenue) * 100).toFixed(1) : null;
      return {
        store_id: store.id,
        store_name: store.name,
        revenue,
        cogs,
        gross_profit: grossProfit,
        gm_expenses: gmExpenses,
        expense_breakdown: expenseCategoryByStore[store.id] || {},
        net_profit: netProfit,
        margin_pct: margin,
        shortages: shortagesByStore[store.id] || null
      };
    });

    res.json(result);
  } catch (err) {
    console.error('P&L error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/owner/top-products?start=&end=&store_id=&limit= ─────────────────
// Top selling items by revenue, cross-store or per store
router.get('/top-products', auth, requireOwner, async (req, res) => {
  try {
    const { start, end, store_id, limit = 20 } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end dates required' });

    let query = supabase
      .from('sales_log')
      .select('item_name, item_id, store_id, net_amount, quantity, stores(name)')
      .gte('sale_date', start)
      .lte('sale_date', end);

    if (store_id) query = query.eq('store_id', store_id);

    const { data, error } = await query;
    if (error) throw error;

    // Aggregate by item name
    const agg = {};
    for (const row of data || []) {
      const key = row.item_name || row.item_id || 'Unknown';
      if (!agg[key]) agg[key] = { item_name: key, total_revenue: 0, total_qty: 0, stores: new Set() };
      agg[key].total_revenue += parseFloat(row.net_amount || 0);
      agg[key].total_qty += parseInt(row.quantity || 1);
      if (row.stores?.name) agg[key].stores.add(row.stores.name);
    }

    const sorted = Object.values(agg)
      .map(a => ({ ...a, stores: [...a.stores] }))
      .sort((a, b) => b.total_revenue - a.total_revenue)
      .slice(0, parseInt(limit));

    res.json(sorted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/owner/inventory-value?store_id= ─────────────────────────────────
// Total stock value (cost × qty) per store
router.get('/inventory-value', auth, requireOwner, async (req, res) => {
  try {
    const { store_id } = req.query;

    // Fetch store names explicitly to avoid FK join failures
    const { data: storeList } = await supabase.from('stores').select('id, name');
    const storeNameMap = Object.fromEntries((storeList || []).map(s => [s.id, s.name]));

    // Paginate to bypass Supabase PostgREST server-side row cap (default 1000)
    let data = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      let q = supabase
        .from('inventory_items')
        .select('store_id, cost, clover_qty, status')
        .neq('status', 'discontinued')
        .range(from, from + PAGE - 1);
      if (store_id) q = q.eq('store_id', store_id);
      const { data: page, error } = await q;
      if (error) throw error;
      if (!page || page.length === 0) break;
      data = data.concat(page);
      if (page.length < PAGE) break;
      from += PAGE;
    }

    const byStore = {};
    for (const item of data || []) {
      const sid = item.store_id;
      if (!byStore[sid]) byStore[sid] = {
        store_id: sid,
        store_name: storeNameMap[sid] || sid,
        total_cost_value: 0,
        total_units: 0,
        item_count: 0
      };
      const qty = Math.max(0, item.clover_qty ?? 0);
      const cost = parseFloat(item.cost || 0);
      byStore[sid].total_cost_value += cost * qty;
      byStore[sid].total_units += qty;
      byStore[sid].item_count += 1;
    }

    res.json(Object.values(byStore));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/owner/stores ─────────────────────────────────────────────────────
// List all stores (owner needs this for dropdowns)
router.get('/stores', auth, requireOwner, async (req, res) => {
  try {
    const { data, error } = await supabase.from('stores').select('id, name').order('name');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/owner/pl-snapshots — save a P&L snapshot ───────────────────────
router.post('/pl-snapshots', auth, requireOwner, async (req, res) => {
  try {
    const { period_type, period_label, start_date, end_date, store_id, data } = req.body;
    if (!period_type || !period_label || !start_date || !end_date || !data) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const { data: snap, error } = await supabase
      .from('pl_snapshots')
      .upsert({ period_type, period_label, start_date, end_date, store_id: store_id || null, data },
               { onConflict: 'period_label,start_date,end_date' })
      .select().single();
    if (error) throw error;
    res.json(snap);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/owner/pl-snapshots — list saved P&L snapshots ───────────────────
router.get('/pl-snapshots', auth, requireOwner, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pl_snapshots')
      .select('id, period_type, period_label, start_date, end_date, store_id, created_at')
      .order('start_date', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/owner/pl-snapshots/:id — get full snapshot data ─────────────────
router.get('/pl-snapshots/:id', auth, requireOwner, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pl_snapshots').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// Export for cron usage
module.exports.autoSnapshotPL = async function autoSnapshotPL(periodType, start, end, label) {
  try {
    // Pull P&L data directly (same logic as /pl route)
    const { data: salesData } = await supabase
      .from('sales_log')
      .select('store_id, net_amount, stores(name)')
      .gte('sale_date', start).lte('sale_date', end);

    const { data: invoices } = await supabase
      .from('budget_invoices')
      .select('store_id, total_cost, stores(name)')
      .gte('created_at', start + 'T00:00:00Z').lte('created_at', end + 'T23:59:59Z');

    const { data: expenses } = await supabase
      .from('store_expenses')
      .select('store_id, amount, stores(name)')
      .gte('expense_date', start).lte('expense_date', end);

    // Aggregate by store
    const byStore = {};
    const ensureStore = (sid, sname) => {
      if (!byStore[sid]) byStore[sid] = { store_id: sid, store_name: sname || sid, revenue: 0, cogs: 0, expenses: 0 };
    };
    for (const r of salesData || []) { ensureStore(r.store_id, r.stores?.name); byStore[r.store_id].revenue += parseFloat(r.net_amount || 0); }
    for (const r of invoices || []) { ensureStore(r.store_id, r.stores?.name); byStore[r.store_id].cogs += parseFloat(r.total_cost || 0); }
    for (const r of expenses || []) { ensureStore(r.store_id, r.stores?.name); byStore[r.store_id].expenses += parseFloat(r.amount || 0); }

    const payload = Object.values(byStore).map(s => ({
      ...s,
      gross_profit: s.revenue - s.cogs,
      net_profit: s.revenue - s.cogs - s.expenses,
      margin: s.revenue > 0 ? (((s.revenue - s.cogs - s.expenses) / s.revenue) * 100).toFixed(1) : null
    }));

    await supabase.from('pl_snapshots').upsert({
      period_type: periodType,
      period_label: label,
      start_date: start,
      end_date: end,
      store_id: null,
      data: payload
    }, { onConflict: 'period_label,start_date,end_date' });

    console.log(`[P&L snapshot] saved: ${label}`);
  } catch (err) {
    console.error('[P&L snapshot] error:', err.message);
  }
};
