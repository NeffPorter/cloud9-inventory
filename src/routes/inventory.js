const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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

    res.json({ store: data });
  } catch (err) {
    console.error('Add store error:', err);
    res.status(500).json({ error: 'Failed to add store' });
  }
});

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

    const { data, error } = await supabase
      .from('inventory_items')
      .select('*')
      .eq('store_id', store_id)
      .order('category')
      .order('group_name')
      .order('variant_name');
      .limit(5000);

    if (error) throw error;
    res.json({ items: data });
  } catch (err) {
    console.error('Get inventory error:', err);
    res.status(500).json({ error: 'Failed to load inventory' });
  }
});

// Update item
router.put('/items/:id', auth, async (req, res) => {
  try {
    const { status, on_hand_qty, suggested_order } = req.body;

    const { data, error } = await supabase
      .from('inventory_items')
      .update({ status, on_hand_qty, suggested_order })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
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
        variant_name: item.name,
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