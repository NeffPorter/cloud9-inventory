const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { cloverFetch, updateItemPriceAndCost, setStockInClover } = require('../services/clover');
const supabase = require('../lib/supabase');

function cleanVariantName(groupName, fullName) {
  if (!groupName) return (fullName || '').toString().trim();
  let variant = (fullName || '').toString().trim();
  const lowerGroup = groupName.toString().trim().toLowerCase();
  if (variant.toLowerCase().startsWith(lowerGroup)) {
    variant = variant.substring(groupName.toString().trim().length).trim();
  }
  variant = variant.replace(/^[\s\-:|$.]+/, '').trim();
  return variant || (fullName || '').toString().trim();
}

// Get stores based on user role
router.get('/stores', auth, async (req, res) => {
  try {
    let query = supabase.from('stores').select('*').order('name');
    if (req.user.role === 'manager' && req.user.store_id) {
      query = query.eq('id', req.user.store_id);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ stores: data });
  } catch (err) {
    console.error('Get stores error:', err);
    res.status(500).json({ error: 'Failed to load stores' });
  }
});

// Add a new store (admin only)
router.post('/stores', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const { name, merchant_id, api_token } = req.body;
    if (!name || !merchant_id || !api_token) {
      return res.status(400).json({ error: 'Name, Merchant ID and API Token are required' });
    }
    const { data, error } = await supabase
      .from('stores')
      .insert([{ name, merchant_id, api_token }])
      .select()
      .single();
    if (error) throw error;

    await supabase.from('store_settings').insert([{
      store_id: data.id,
      lead_time: 5,
      buffer_days: 14
    }]);

    // Auto-sync inventory in background
    triggerBackgroundSync(data);

    res.json({ store: data });
  } catch (err) {
    console.error('Add store error:', err);
    res.status(500).json({ error: 'Failed to add store' });
  }
});

async function triggerBackgroundSync(store) {
  try {
    console.log(`🔄 Starting background sync for ${store.name}...`);
    const { cloverFetch } = require('../services/clover');

    let allItems = [];
    let offset = 0;
    const limit = 200;
    let keepGoing = true;

    while (keepGoing) {
      const data = await cloverFetch(
        `items?expand=itemStock,categories,itemGroup&limit=${limit}&offset=${offset}`,
        store.merchant_id,
        store.api_token
      );
      const elements = data.elements || [];
      allItems = allItems.concat(elements);
      if (elements.length < limit) {
        keepGoing = false;
      } else {
        offset += limit;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    const groupsData = await cloverFetch('item_groups?limit=1000', store.merchant_id, store.api_token);
    const groupMap = {};
    (groupsData.elements || []).forEach(g => {
      if (g.id && g.name) groupMap[g.id] = g.name.trim();
    });

    for (const item of allItems) {
      if (item.deleted || !item.name) continue;
      const category = item.categories?.elements?.[0]?.name || 'No Category';
      const groupName = item.itemGroup?.id ? (groupMap[item.itemGroup.id] || '') : '';
      const cloverQty = item.itemStock ? item.itemStock.quantity : 0;
      const cost = item.cost ? (item.cost / 100) : 0;
      const price = item.price ? (item.price / 100) : 0;

      await supabase.from('inventory_items').upsert([{
        id: item.id,
        store_id: store.id,
        category,
        group_name: groupName,
        variant_name: cleanVariantName(groupName, item.name),
        cost,
        price,
        clover_qty: cloverQty,
        last_synced: new Date().toISOString()
      }], { onConflict: 'id' });
    }

    console.log(`✅ Background sync complete for ${store.name}: ${allItems.length} items`);
  } catch (err) {
    console.error(`Background sync failed for ${store.name}:`, err.message);
  }
}

// Delete a store (admin only) — cascades through all related tables first
router.delete('/stores/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const storeId = req.params.id;

    // Delete related records in safe order (leaves → store)
    const related = [
      'store_settings',
      'discount_schedules',
      'sale_events',
      'store_tasks',
      'sales_log',
      'inventory_items',
      'distributor_store_lead_times',
      'purchase_orders',
      'budgets',
      'notifications',
    ];
    for (const table of related) {
      const { error: delErr } = await supabase.from(table).delete().eq('store_id', storeId);
      if (delErr) console.warn(`Could not delete from ${table} for store ${storeId}:`, delErr.message);
    }

    const { error } = await supabase.from('stores').delete().eq('id', storeId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Delete store error:', err);
    res.status(500).json({ error: err.message || 'Failed to delete store' });
  }
});

// Get inventory for a store
router.get('/items', auth, async (req, res) => {
  try {
    const { store_id } = req.query;
    if (!store_id) return res.status(400).json({ error: 'store_id required' });

    if (req.user.role === 'manager' && req.user.store_id !== store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    let allItems = [];
    let from = 0;
    const pageSize = 1000;
    let keepGoing = true;

    while (keepGoing) {
      const { data, error } = await supabase
        .from('inventory_items')
        .select('*')
        .eq('store_id', store_id)
        .order('category')
        .order('group_name')
        .order('variant_name')
        .range(from, from + pageSize - 1);

      if (error) throw error;
      allItems = allItems.concat(data || []);
      if ((data || []).length < pageSize) {
        keepGoing = false;
      } else {
        from += pageSize;
      }
    }

    res.json({ items: allItems });
  } catch (err) {
    console.error('Get inventory error:', err);
    res.status(500).json({ error: 'Failed to load inventory' });
  }
});
router.put('/items/:id', auth, async (req, res) => {
  try {
    const { status, on_hand_qty, suggested_order, price, cost, clover_qty } = req.body;

    const updateData = {};
    if (status !== undefined) updateData.status = status;
    if (on_hand_qty !== undefined) updateData.on_hand_qty = on_hand_qty;
    if (suggested_order !== undefined) updateData.suggested_order = suggested_order;
    if (price !== undefined) updateData.price = price;
    if (cost !== undefined) updateData.cost = cost;
    if (clover_qty !== undefined) updateData.clover_qty = clover_qty;

    const { data, error } = await supabase
      .from('inventory_items')
      .update(updateData)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    if (data) {
      const { data: store } = await supabase
        .from('stores')
        .select('*')
        .eq('id', data.store_id)
        .single();

      if (store) {
        if (price !== undefined || cost !== undefined) {
          await updateItemPriceAndCost(
            store.merchant_id,
            store.api_token,
            req.params.id,
            price !== undefined ? price : data.price,
            cost !== undefined ? cost : data.cost
          );
        }
        if (clover_qty !== undefined) {
          await setStockInClover(
            store.merchant_id,
            store.api_token,
            req.params.id,
            clover_qty
          );
        }
      }
    }

    res.json({ item: data });
  } catch (err) {
    console.error('Update item error:', err);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// Sync inventory from Clover
router.post('/sync/:store_id', auth, async (req, res) => {
  try {
    const { store_id } = req.params;

    const { data: store, error } = await supabase
      .from('stores')
      .select('*')
      .eq('id', store_id)
      .single();

    if (error || !store) return res.status(404).json({ error: 'Store not found' });

    const { cloverFetch } = require('../services/clover');

    let allItems = [];
    let offset = 0;
    const limit = 200;
    let keepGoing = true;

    while (keepGoing) {
      const data = await cloverFetch(
        `items?expand=itemStock,categories,itemGroup&limit=${limit}&offset=${offset}`,
        store.merchant_id,
        store.api_token
      );
      const elements = data.elements || [];
      allItems = allItems.concat(elements);
      console.log(`Fetched ${allItems.length} items so far...`);
      if (elements.length < limit) {
        keepGoing = false;
      } else {
        offset += limit;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log(`Total items fetched: ${allItems.length}`);

    const groupsData = await cloverFetch('item_groups?limit=1000', store.merchant_id, store.api_token);
    const groupMap = {};
    (groupsData.elements || []).forEach(g => {
      if (g.id && g.name) groupMap[g.id] = g.name.trim();
    });

    let synced = 0;
    for (const item of allItems) {
      if (item.deleted || !item.name) continue;

      const category = item.categories?.elements?.[0]?.name || 'No Category';
      const groupName = item.itemGroup?.id ? (groupMap[item.itemGroup.id] || '') : '';
      const cloverQty = item.itemStock ? item.itemStock.quantity : 0;
      const cost = item.cost ? (item.cost / 100) : 0;
      const price = item.price ? (item.price / 100) : 0;

      await supabase.from('inventory_items').upsert([{
        id: item.id,
        store_id: store.id,
        category,
        group_name: groupName,
        variant_name: cleanVariantName(groupName, item.name),
        cost,
        price,
        clover_qty: cloverQty,
        last_synced: new Date().toISOString()
      }], { onConflict: 'id' });

      synced++;
    }

    res.json({ success: true, synced });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});
// Save stock take report
router.post('/stocktake/reports', auth, async (req, res) => {
  try {
    const { store_id, categories, total_counted, total_matches, total_shortages, total_overages, discrepancies } = req.body;

    const { data, error } = await supabase
      .from('stock_take_reports')
      .insert([{
        store_id,
        categories,
        total_counted,
        total_matches,
        total_shortages,
        total_overages,
        discrepancies
      }])
      .select()
      .single();

    if (error) throw error;
    res.json({ report: data });
  } catch (err) {
    console.error('Save report error:', err);
    res.status(500).json({ error: 'Failed to save report' });
  }
});

// Update stock take report (status, notes, applied_to_clover)
router.put('/stocktake/reports/:id', auth, async (req, res) => {
  try {
    const { status, notes, applied_to_clover } = req.body;

    // Managers can only update reports for their own store, and only set status to 'resolved'
    if (req.user.role === 'manager') {
      const { data: report } = await supabase
        .from('stock_take_reports')
        .select('store_id')
        .eq('id', req.params.id)
        .single();

      if (!report || report.store_id !== req.user.store_id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (status && status !== 'resolved') {
        return res.status(403).json({ error: 'Managers can only mark reports as resolved' });
      }
    }

    const updateData = {};
    if (status !== undefined) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;
    if (applied_to_clover !== undefined) updateData.applied_to_clover = applied_to_clover;

    const { data, error } = await supabase
      .from('stock_take_reports')
      .update(updateData)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ report: data });
  } catch (err) {
    console.error('Update report error:', err);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

// Get stock take reports for a store
router.get('/stocktake/reports', auth, async (req, res) => {
  try {
    const { store_id } = req.query;

    let query = supabase
      .from('stock_take_reports')
      .select('*')
      .order('created_at', { ascending: false });

    if (store_id) query = query.eq('store_id', store_id);
    else if (req.user.role === 'manager' && req.user.store_id) {
      query = query.eq('store_id', req.user.store_id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ reports: data });
  } catch (err) {
    console.error('Get reports error:', err);
    res.status(500).json({ error: 'Failed to load reports' });
  }
});
// Save stock take draft
router.post('/stocktake/drafts', auth, async (req, res) => {
  try {
    const { store_id, counts, cat_status } = req.body;

    // Check if draft already exists for this store
    const { data: existing } = await supabase
      .from('stock_take_drafts')
      .select('id')
      .eq('store_id', store_id)
      .eq('status', 'in_progress')
      .single();

    let data, error;

    if (existing) {
      // Update existing draft
      ({ data, error } = await supabase
        .from('stock_take_drafts')
        .update({ counts, cat_status, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select()
        .single());
    } else {
      // Create new draft
      ({ data, error } = await supabase
        .from('stock_take_drafts')
        .insert([{
          store_id,
          created_by_name: req.user.name || req.user.email,
          counts,
          cat_status
        }])
        .select()
        .single());
    }

    if (error) throw error;
    res.json({ draft: data });
  } catch (err) {
    console.error('Save draft error:', err);
    res.status(500).json({ error: 'Failed to save draft' });
  }
});

// Get draft for a store
router.get('/stocktake/drafts', auth, async (req, res) => {
  try {
    const { store_id } = req.query;

    let query = supabase
      .from('stock_take_drafts')
      .select('*')
      .eq('status', 'in_progress')
      .order('updated_at', { ascending: false });

    if (store_id) query = query.eq('store_id', store_id);
    else if (req.user.role === 'manager' && req.user.store_id) {
      query = query.eq('store_id', req.user.store_id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ drafts: data });
  } catch (err) {
    console.error('Get drafts error:', err);
    res.status(500).json({ error: 'Failed to load drafts' });
  }
});

// Delete draft (when finished)
router.delete('/stocktake/drafts/:id', auth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('stock_take_drafts')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Delete draft error:', err);
    res.status(500).json({ error: 'Failed to delete draft' });
  }
});

// === CATEGORY SETTINGS ===

// GET category settings for a store
router.get('/category-settings', auth, async (req, res) => {
  try {
    const { store_id } = req.query;
    if (!store_id) return res.status(400).json({ error: 'store_id required' });
    if (req.user.role === 'manager' && req.user.store_id !== store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { data, error } = await supabase
      .from('category_settings')
      .select('*')
      .eq('store_id', store_id);
    if (error) throw error;
    res.json({ settings: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET category-level aggregate stats
router.get('/category-stats', auth, async (req, res) => {
  try {
    const { store_id } = req.query;
    if (!store_id) return res.status(400).json({ error: 'store_id required' });
    if (req.user.role === 'manager' && req.user.store_id !== store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { data: items, error } = await supabase
      .from('inventory_items')
      .select('category, clover_qty, suggested_order, status')
      .eq('store_id', store_id);
    if (error) throw error;

    const cats = {};
    (items || []).forEach(item => {
      const cat = item.category || 'No Category';
      if (!cats[cat]) cats[cat] = { item_count: 0, total_stock: 0, total_suggested: 0, reorder_count: 0 };
      cats[cat].item_count++;
      cats[cat].total_stock += item.clover_qty || 0;
      cats[cat].total_suggested += item.suggested_order || 0;
      if ((item.suggested_order || 0) > 0) cats[cat].reorder_count++;
    });

    res.json({ categories: cats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upsert category settings (admin only) — buffer_days + low_stock_threshold; lead time comes from cheapest distributor
router.put('/category-settings', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { store_id, category, buffer_days, low_stock_threshold } = req.body;
    if (!store_id || !category) return res.status(400).json({ error: 'store_id and category required' });

    const { data, error } = await supabase
      .from('category_settings')
      .upsert([{
        store_id,
        category,
        buffer_days: parseInt(buffer_days) || 3,
        low_stock_threshold: parseInt(low_stock_threshold) || 5,
        updated_at: new Date().toISOString()
      }], { onConflict: 'store_id,category' })
      .select()
      .single();

    if (error) throw error;
    res.json({ setting: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recalculate suggested orders for a category.
// Lead time comes from cheapest distributor per item; buffer_days is per category.
router.post('/category-settings/recalculate', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { store_id, category, buffer_days, lookback_days } = req.body;
    if (!store_id || !category) return res.status(400).json({ error: 'store_id and category required' });

    const buffer = parseInt(buffer_days) || 3;
    const lookback = parseInt(lookback_days) || 14;

    // Get all items in this category
    const { data: items, error: itemsError } = await supabase
      .from('inventory_items')
      .select('id, clover_qty')
      .eq('store_id', store_id)
      .eq('category', category);

    if (itemsError) throw itemsError;
    if (!items || items.length === 0) return res.json({ updated: 0 });

    const itemIdSet = new Set(items.map(i => i.id));

    // Build cheapest-distributor map per item
    const { data: allPrices } = await supabase
      .from('distributor_prices')
      .select('item_id, distributor_id, unit_cost')
      .eq('store_id', store_id)
      .gt('unit_cost', 0);

    const cheapestDistMap = {}; // item_id -> distributor_id
    (allPrices || []).forEach(p => {
      if (!itemIdSet.has(p.item_id)) return;
      if (!cheapestDistMap[p.item_id] || p.unit_cost < cheapestDistMap[p.item_id].cost) {
        cheapestDistMap[p.item_id] = { distributor_id: p.distributor_id, cost: p.unit_cost };
      }
    });

    // Load lead times for every distinct cheapest distributor at this store
    const distIds = [...new Set(Object.values(cheapestDistMap).map(v => v.distributor_id))];
    const leadTimeMap = {}; // distributor_id -> lead_time_days
    if (distIds.length > 0) {
      const { data: lts } = await supabase
        .from('distributor_lead_times')
        .select('distributor_id, lead_time_days')
        .eq('store_id', store_id)
        .in('distributor_id', distIds);
      (lts || []).forEach(lt => { leadTimeMap[lt.distributor_id] = lt.lead_time_days; });
    }

    // Sales data for lookback period
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - lookback);

    const { data: salesRows } = await supabase
      .from('sales_log')
      .select('item_summary, type')
      .eq('store_id', store_id)
      .gte('created_at', cutoff.toISOString());

    const soldMap = {};
    items.forEach(i => { soldMap[i.id] = 0; });

    (salesRows || []).forEach(row => {
      if (!row.item_summary || row.item_summary === 'N/A') return;
      row.item_summary.split(',').forEach(part => {
        const match = part.trim().match(/^([A-Za-z0-9]+)\s+x(\d+\.?\d*)/i);
        if (match && itemIdSet.has(match[1])) {
          const qty = parseFloat(match[2]) || 1;
          soldMap[match[1]] = (soldMap[match[1]] || 0) + (row.type === 'Refund' ? -qty : qty);
        }
      });
    });

    // Calculate and update each item
    let updated = 0;
    for (const item of items) {
      const unitsSold = Math.max(0, soldMap[item.id] || 0);
      const dailyRate = unitsSold / lookback;

      // Lead time = cheapest distributor's lead time at this store, default 7
      const cheapest = cheapestDistMap[item.id];
      const leadTime = cheapest && leadTimeMap[cheapest.distributor_id] != null
        ? leadTimeMap[cheapest.distributor_id]
        : 7;

      const suggestedQty = Math.max(0, Math.ceil((dailyRate * (leadTime + buffer)) - (item.clover_qty || 0)));

      await supabase
        .from('inventory_items')
        .update({ suggested_order: suggestedQty })
        .eq('id', item.id)
        .eq('store_id', store_id);
      updated++;
    }

    res.json({ success: true, updated, category });
  } catch (err) {
    console.error('Recalculate error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;