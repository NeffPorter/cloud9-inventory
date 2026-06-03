const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');
const { cloverFetch, updateItemPriceAndCost, setStockInClover } = require('../services/clover');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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

// Delete a store (admin only)
router.delete('/stores/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const { error } = await supabase
      .from('stores')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Delete store error:', err);
    res.status(500).json({ error: 'Failed to delete store' });
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

module.exports = router;