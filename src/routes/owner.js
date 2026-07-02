const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../lib/supabase');

const { isOwnerLevel } = require('../lib/roles');

// Allows owner-level roles AND gm/store_user (with store scoping applied per-endpoint)
function requireOwnerOrStore(req, res, next) {
  const role = req.user.role;
  if (!isOwnerLevel(role) && role !== 'gm' && role !== 'store_user') {
    return res.status(403).json({ error: 'Access required' });
  }
  next();
}

// Returns the effective store_id for the request.
// gm/store_user are always forced to their own store.
// Owner-level roles use the query param (or null = all stores).
function effectiveStore(req, queryStoreId) {
  const role = req.user.role;
  if (role === 'gm' || role === 'store_user') return req.user.store_id || null;
  return queryStoreId || null;
}

// ── GET /api/owner/inventory-search?q=&store_id= ─────────────────────────────
// Cross-store product search — fuzzy: matches any word across name/group_name/variant_name/category
router.get('/inventory-search', auth, requireOwnerOrStore, async (req, res) => {
  try {
    const { q, store_id: rawStoreId } = req.query;
    const store_id = effectiveStore(req, rawStoreId);
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
router.get('/pl', auth, requireOwnerOrStore, async (req, res) => {
  try {
    const { start, end, store_id: rawStoreId } = req.query;
    const store_id = effectiveStore(req, rawStoreId);
    if (!start || !end) return res.status(400).json({ error: 'start and end dates required' });

    let storeQuery = supabase.from('stores').select('id, name');
    if (store_id) storeQuery = storeQuery.eq('id', store_id);
    const { data: stores } = await storeQuery;
    if (!stores?.length) return res.json([]);
    const storeIds = stores.map(s => s.id);

    // ── Sales: separate sales from refunds ────────────────────────────
    const { data: salesData } = await supabase
      .from('sales_log')
      .select('store_id, net, gross, discounts, type')
      .in('store_id', storeIds)
      .gte('created_at', start + 'T00:00:00')
      .lte('created_at', end + 'T23:59:59');

    const grossSalesByStore = {}, discountsByStore = {}, refundsByStore = {};
    for (const row of salesData || []) {
      if (row.type === 'Refund') {
        refundsByStore[row.store_id] = (refundsByStore[row.store_id] || 0) + Math.abs(parseFloat(row.net || 0));
      } else {
        grossSalesByStore[row.store_id] = (grossSalesByStore[row.store_id] || 0) + parseFloat(row.gross || 0);
        discountsByStore[row.store_id] = (discountsByStore[row.store_id] || 0) + parseFloat(row.discounts || 0);
      }
    }

    // ── COGS: budget invoices broken down by distributor ──────────────
    const { data: budgets } = await supabase
      .from('weekly_budgets')
      .select('id, store_id')
      .in('store_id', storeIds)
      .lte('week_start', end)
      .gte('week_end', start);

    const budgetIds = (budgets || []).map(b => b.id);
    const budgetStoreMap = Object.fromEntries((budgets || []).map(b => [b.id, b.store_id]));
    const purchasesByStore = {}, cogsByDistByStore = {};

    if (budgetIds.length > 0) {
      const { data: invoices } = await supabase
        .from('budget_invoices')
        .select('budget_id, distributor_name, invoice_amount')
        .in('budget_id', budgetIds);
      for (const inv of invoices || []) {
        const sid = budgetStoreMap[inv.budget_id];
        if (!sid) continue;
        const dist = inv.distributor_name || 'Other';
        const amt = parseFloat(inv.invoice_amount || 0);
        purchasesByStore[sid] = (purchasesByStore[sid] || 0) + amt;
        if (!cogsByDistByStore[sid]) cogsByDistByStore[sid] = {};
        cogsByDistByStore[sid][dist] = (cogsByDistByStore[sid][dist] || 0) + amt;
      }
    }
    // Fallback to total_invoiced if no invoice-level data
    if (Object.keys(purchasesByStore).length === 0) {
      const { data: wb } = await supabase
        .from('weekly_budgets').select('store_id, total_invoiced')
        .in('store_id', storeIds).lte('week_start', end).gte('week_end', start);
      for (const b of wb || []) {
        purchasesByStore[b.store_id] = (purchasesByStore[b.store_id] || 0) + parseFloat(b.total_invoiced || 0);
      }
    }

    // ── Inventory Snapshots for COGS formula ─────────────────────────
    // COGS = Beginning Inventory + Purchases - Ending Inventory
    const { data: snapshots } = await supabase
      .from('inventory_snapshots')
      .select('store_id, snapshot_date, total_value')
      .in('store_id', storeIds)
      .order('snapshot_date', { ascending: true });

    const beginInvByStore = {}, endInvByStore = {};
    for (const sid of storeIds) {
      const storeSnaps = (snapshots || []).filter(s => s.store_id === sid);
      // Beginning: closest snapshot on or before start date
      const before = storeSnaps.filter(s => s.snapshot_date <= start);
      if (before.length > 0) beginInvByStore[sid] = parseFloat(before[before.length - 1].total_value);
      // Ending: closest snapshot on or after end date
      const after = storeSnaps.filter(s => s.snapshot_date >= end);
      if (after.length > 0) endInvByStore[sid] = parseFloat(after[0].total_value);
      else {
        // Fall back to most recent snapshot before end
        const beforeEnd = storeSnaps.filter(s => s.snapshot_date <= end);
        if (beforeEnd.length > 0) endInvByStore[sid] = parseFloat(beforeEnd[beforeEnd.length - 1].total_value);
      }
    }

    // Compute COGS per store: beginning + purchases - ending (or just purchases if no snapshots)
    const cogsByStore = {};
    for (const sid of storeIds) {
      const purchases = purchasesByStore[sid] || 0;
      const beginInv = beginInvByStore[sid];
      const endInv = endInvByStore[sid];
      if (beginInv !== undefined && endInv !== undefined) {
        cogsByStore[sid] = beginInv + purchases - endInv;
      } else {
        cogsByStore[sid] = purchases;
      }
    }

    // ── Operating Expenses ────────────────────────────────────────────
    const { data: expenses } = await supabase
      .from('store_expenses').select('store_id, amount, category')
      .in('store_id', storeIds).gte('expense_date', start).lte('expense_date', end);

    const opExByStore = {}, opExCatByStore = {};
    for (const exp of expenses || []) {
      opExByStore[exp.store_id] = (opExByStore[exp.store_id] || 0) + parseFloat(exp.amount);
      if (!opExCatByStore[exp.store_id]) opExCatByStore[exp.store_id] = {};
      opExCatByStore[exp.store_id][exp.category] =
        (opExCatByStore[exp.store_id][exp.category] || 0) + parseFloat(exp.amount);
    }

    // ── Stocktake shortages — sum ALL stocktakes within the period ───────
    const { data: stocktakes } = await supabase
      .from('stock_take_reports').select('id, store_id, discrepancies, created_at')
      .in('store_id', storeIds)
      .gte('created_at', start + 'T00:00:00')
      .lte('created_at', end + 'T23:59:59')
      .order('created_at', { ascending: true });

    const shortagesByStore = {};
    for (const st of stocktakes || []) {
      const sid = st.store_id;
      if (!shortagesByStore[sid]) shortagesByStore[sid] = { items: 0, value: 0, count: 0, stocktake_date: st.created_at?.slice(0, 10) };
      for (const d of (st.discrepancies || [])) {
        if (d.diff < 0) {
          shortagesByStore[sid].items += Math.abs(d.diff);
          shortagesByStore[sid].value += Math.abs(d.diff) * parseFloat(d.item?.price || d.price || 0);
        }
      }
      shortagesByStore[sid].count++;
      shortagesByStore[sid].stocktake_date = st.created_at?.slice(0, 10); // last one
    }

    // ── Assemble result ───────────────────────────────────────────────
    const result = stores.map(store => {
      const grossSales = grossSalesByStore[store.id] || 0;
      const discounts = discountsByStore[store.id] || 0;
      const refunds = refundsByStore[store.id] || 0;
      const netSales = grossSales - discounts - refunds;
      const purchases = purchasesByStore[store.id] || 0;
      const beginInv = beginInvByStore[store.id] ?? null;
      const endInv = endInvByStore[store.id] ?? null;
      const cogs = cogsByStore[store.id] || 0;
      const grossProfit = netSales - cogs;
      const opEx = opExByStore[store.id] || 0;
      const netProfit = grossProfit - opEx;
      return {
        store_id: store.id,
        store_name: store.name,
        gross_sales: grossSales,
        discounts,
        refunds,
        net_sales: netSales,
        beginning_inventory: beginInv,
        purchases,
        ending_inventory: endInv,
        cogs,
        cogs_by_distributor: cogsByDistByStore[store.id] || {},
        gross_profit: grossProfit,
        gross_margin_pct: netSales > 0 ? ((grossProfit / netSales) * 100).toFixed(1) : null,
        op_ex: opEx,
        expense_breakdown: opExCatByStore[store.id] || {},
        net_profit: netProfit,
        net_margin_pct: netSales > 0 ? ((netProfit / netSales) * 100).toFixed(1) : null,
        revenue: netSales, gm_expenses: opEx, margin_pct: netSales > 0 ? ((netProfit / netSales) * 100).toFixed(1) : null,
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
router.get('/top-products', auth, requireOwnerOrStore, async (req, res) => {
  try {
    const { start, end, store_id: rawStoreId, limit = 20 } = req.query;
    const store_id = effectiveStore(req, rawStoreId);
    if (!start || !end) return res.status(400).json({ error: 'start and end dates required' });

    let query = supabase
      .from('sales_log')
      .select('item_summary, store_id, net')
      .gte('created_at', start + 'T00:00:00')
      .lte('created_at', end + 'T23:59:59');

    if (store_id) query = query.eq('store_id', store_id);

    const { data, error } = await query;
    if (error) throw error;

    // Fetch store names
    const { data: storeList2 } = await supabase.from('stores').select('id, name');
    const storeMap2 = Object.fromEntries((storeList2 || []).map(s => [s.id, s.name]));

    // Collect all unique item IDs from item_summary fields
    const allItemIds = new Set();
    for (const row of data || []) {
      const matches = (row.item_summary || '').matchAll(/([A-Z0-9]{5,})\s+x\d+/g);
      for (const m of matches) allItemIds.add(m[1]);
    }

    // Fetch names for those items
    const itemNameMap = {};
    if (allItemIds.size > 0) {
      const { data: itemRows } = await supabase
        .from('inventory_items')
        .select('id, group_name, variant_name')
        .in('id', [...allItemIds]);
      for (const item of itemRows || []) {
        itemNameMap[item.id] = item.group_name || item.variant_name || item.id;
      }
    }

    // Aggregate by item name, splitting order revenue across items
    const agg = {};
    for (const row of data || []) {
      const summary = row.item_summary || '';
      const matches = [...summary.matchAll(/([A-Z0-9]{5,})\s+x(\d+)/g)];
      const orderRevenue = parseFloat(row.net || 0);
      const sname = storeMap2[row.store_id];

      if (matches.length === 0) {
        const key = 'Other';
        if (!agg[key]) agg[key] = { item_name: key, total_revenue: 0, total_qty: 0, stores: new Set() };
        agg[key].total_revenue += orderRevenue;
        agg[key].total_qty += 1;
        if (sname) agg[key].stores.add(sname);
      } else {
        const revenueEach = orderRevenue / matches.length;
        for (const m of matches) {
          const itemId = m[1];
          const qty = parseInt(m[2]) || 1;
          const key = itemNameMap[itemId] || itemId;
          if (!agg[key]) agg[key] = { item_name: key, total_revenue: 0, total_qty: 0, stores: new Set() };
          agg[key].total_revenue += revenueEach;
          agg[key].total_qty += qty;
          if (sname) agg[key].stores.add(sname);
        }
      }
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
router.get('/inventory-value', auth, requireOwnerOrStore, async (req, res) => {
  try {
    const { store_id: rawStoreId } = req.query;
    const store_id = effectiveStore(req, rawStoreId);

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
// List stores — gm/store_user only see their own store
router.get('/stores', auth, requireOwnerOrStore, async (req, res) => {
  try {
    const role = req.user.role;
    let query = supabase.from('stores').select('id, name').order('name');
    if ((role === 'gm' || role === 'store_user') && req.user.store_id) {
      query = query.eq('id', req.user.store_id);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/owner/pl-snapshots — save a P&L snapshot ───────────────────────
router.post('/pl-snapshots', auth, requireOwnerOrStore, async (req, res) => {
  try {
    const { period_type, period_label, start_date, end_date, store_id, data } = req.body;
    if (!period_type || !period_label || !start_date || !end_date || !data) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    // gm/store_user can only save snapshots for their own store
    const role = req.user.role;
    const effectiveStoreId = (role === 'gm' || role === 'store_user')
      ? (req.user.store_id || null)
      : (store_id || null);

    const { data: snap, error } = await supabase
      .from('pl_snapshots')
      .upsert({ period_type, period_label, start_date, end_date, store_id: effectiveStoreId, data },
               { onConflict: 'period_label,start_date,end_date' })
      .select().single();
    if (error) throw error;
    res.json(snap);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/owner/pl-snapshots — list saved P&L snapshots ───────────────────
router.get('/pl-snapshots', auth, requireOwnerOrStore, async (req, res) => {
  try {
    const role = req.user.role;
    let query = supabase
      .from('pl_snapshots')
      .select('id, period_type, period_label, start_date, end_date, store_id, created_at')
      .order('start_date', { ascending: false });
    // gm/store_user only see snapshots for their store (or global snapshots with null store_id)
    if ((role === 'gm' || role === 'store_user') && req.user.store_id) {
      query = query.or(`store_id.eq.${req.user.store_id},store_id.is.null`);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/owner/pl-snapshots/:id — get full snapshot data ─────────────────
router.get('/pl-snapshots/:id', auth, requireOwnerOrStore, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pl_snapshots').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    // gm/store_user: only allow if snapshot is theirs or global
    const role = req.user.role;
    if ((role === 'gm' || role === 'store_user') && data.store_id && data.store_id !== req.user.store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// Export for cron usage — reuses the same /pl logic for consistency
module.exports.autoSnapshotPL = async function autoSnapshotPL(periodType, start, end, label) {
  try {
    // Reuse the same aggregation logic as GET /api/owner/pl
    const { data: stores } = await supabase.from('stores').select('id, name');
    if (!stores?.length) return;
    const storeIds = stores.map(s => s.id);

    const { data: salesData } = await supabase
      .from('sales_log').select('store_id, net, gross, discounts, type')
      .in('store_id', storeIds)
      .gte('created_at', start + 'T00:00:00').lte('created_at', end + 'T23:59:59');

    const grossByStore = {}, discountsByStore = {}, refundsByStore = {};
    for (const r of salesData || []) {
      if (r.type === 'Refund') {
        refundsByStore[r.store_id] = (refundsByStore[r.store_id] || 0) + Math.abs(parseFloat(r.net || 0));
      } else {
        grossByStore[r.store_id]     = (grossByStore[r.store_id]     || 0) + parseFloat(r.gross     || 0);
        discountsByStore[r.store_id] = (discountsByStore[r.store_id] || 0) + parseFloat(r.discounts || 0);
      }
    }

    const { data: budgets } = await supabase
      .from('weekly_budgets').select('id, store_id')
      .in('store_id', storeIds).lte('week_start', end).gte('week_end', start);
    const budgetIds = (budgets || []).map(b => b.id);
    const budgetStoreMap = Object.fromEntries((budgets || []).map(b => [b.id, b.store_id]));
    const purchasesByStore = {};
    if (budgetIds.length > 0) {
      const { data: invoices } = await supabase
        .from('budget_invoices').select('budget_id, invoice_amount').in('budget_id', budgetIds);
      for (const inv of invoices || []) {
        const sid = budgetStoreMap[inv.budget_id];
        if (sid) purchasesByStore[sid] = (purchasesByStore[sid] || 0) + parseFloat(inv.invoice_amount || 0);
      }
    }

    const { data: expenses } = await supabase
      .from('store_expenses').select('store_id, amount')
      .in('store_id', storeIds).gte('expense_date', start).lte('expense_date', end);
    const opExByStore = {};
    for (const e of expenses || []) {
      opExByStore[e.store_id] = (opExByStore[e.store_id] || 0) + parseFloat(e.amount || 0);
    }

    const payload = stores.map(store => {
      const gross    = grossByStore[store.id]     || 0;
      const disc     = discountsByStore[store.id] || 0;
      const refunds  = refundsByStore[store.id]   || 0;
      const netSales = gross - disc - refunds;
      const cogs     = purchasesByStore[store.id] || 0;
      const opEx     = opExByStore[store.id]      || 0;
      const grossProfit = netSales - cogs;
      const netProfit   = grossProfit - opEx;
      return {
        store_id: store.id, store_name: store.name,
        gross_sales: gross, discounts: disc, refunds, net_sales: netSales,
        cogs, gross_profit: grossProfit, op_ex: opEx, net_profit: netProfit,
        net_margin_pct: netSales > 0 ? ((netProfit / netSales) * 100).toFixed(1) : null
      };
    });

    await supabase.from('pl_snapshots').upsert({
      period_type: periodType, period_label: label,
      start_date: start, end_date: end, store_id: null, data: payload
    }, { onConflict: 'period_label,start_date,end_date' });

    console.log(`[P&L snapshot] saved: ${label}`);
  } catch (err) {
    console.error('[P&L snapshot] error:', err.message);
  }
};
