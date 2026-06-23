const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../lib/supabase');

const OWNER_ROLES = ['admin', 'owner'];

function requireOwner(req, res, next) {
  if (!OWNER_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Owner access required' });
  next();
}

// ── GET /api/owner/inventory-search?q=&store_id= ─────────────────────────────
// Cross-store product search by name
router.get('/inventory-search', auth, requireOwner, async (req, res) => {
  try {
    const { q, store_id } = req.query;
    if (!q || q.trim().length < 2) return res.json([]);

    let query = supabase
      .from('inventory_items')
      .select('id, store_id, name, variant_name, group_name, category, price, cost, clover_qty, status, stores(name)')
      .ilike('name', `%${q.trim()}%`)
      .order('name');

    if (store_id) query = query.eq('store_id', store_id);

    const { data, error } = await query;
    if (error) throw error;

    // Group results by product name + variant for easy display
    const grouped = {};
    for (const item of data || []) {
      const key = item.group_name || item.name;
      if (!grouped[key]) grouped[key] = { name: key, variants: [] };
      grouped[key].variants.push({
        id: item.id,
        store_id: item.store_id,
        store_name: item.stores?.name || '—',
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
        margin_pct: margin
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

    let query = supabase
      .from('inventory_items')
      .select('store_id, cost, clover_qty, status, stores(name)')
      .neq('status', 'discontinued');

    if (store_id) query = query.eq('store_id', store_id);

    const { data, error } = await query;
    if (error) throw error;

    const byStore = {};
    for (const item of data || []) {
      const sid = item.store_id;
      if (!byStore[sid]) byStore[sid] = { store_id: sid, store_name: item.stores?.name || sid, total_cost_value: 0, total_units: 0, item_count: 0 };
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

module.exports = router;
