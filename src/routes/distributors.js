const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');
const { updateItemPriceAndCost } = require('../services/clover');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// Get best price per item_id across all distributors for a store
// IMPORTANT: this route must be before /:id routes
router.get('/best-prices', auth, async (req, res) => {
  try {
    const { store_id } = req.query;
    if (!store_id) return res.status(400).json({ error: 'store_id required' });

    if (req.user.role === 'manager' && req.user.store_id !== store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: prices, error } = await supabase
      .from('distributor_prices')
      .select('item_id, unit_cost, distributor_id, distributors(name)')
      .eq('store_id', store_id)
      .gt('unit_cost', 0);

    if (error) throw error;

    // Build best (lowest cost) price map per item
    const bestMap = {};
    (prices || []).forEach(p => {
      if (!bestMap[p.item_id] || p.unit_cost < bestMap[p.item_id].unit_cost) {
        bestMap[p.item_id] = {
          unit_cost: p.unit_cost,
          distributor_id: p.distributor_id,
          distributor_name: p.distributors?.name || 'Unknown'
        };
      }
    });

    res.json({ best_prices: bestMap });
  } catch (err) {
    console.error('Best prices error:', err);
    res.status(500).json({ error: err.message });
  }
});

// List distributors for a store
router.get('/', auth, async (req, res) => {
  try {
    const { store_id } = req.query;
    if (!store_id) return res.status(400).json({ error: 'store_id required' });

    if (req.user.role === 'manager' && req.user.store_id !== store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data, error } = await supabase
      .from('distributors')
      .select('*')
      .eq('store_id', store_id)
      .order('name');

    if (error) throw error;
    res.json({ distributors: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single distributor + its prices
router.get('/:id/prices', auth, async (req, res) => {
  try {
    const { data: dist, error: distError } = await supabase
      .from('distributors')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (distError || !dist) return res.status(404).json({ error: 'Distributor not found' });
    if (req.user.role === 'manager' && req.user.store_id !== dist.store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: prices, error: pricesError } = await supabase
      .from('distributor_prices')
      .select('*')
      .eq('distributor_id', req.params.id)
      .eq('store_id', dist.store_id);

    if (pricesError) throw pricesError;
    res.json({ distributor: dist, prices: prices || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create distributor (admin only)
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const { store_id, name, website, notes } = req.body;
    if (!store_id || !name) return res.status(400).json({ error: 'store_id and name required' });

    const { data, error } = await supabase
      .from('distributors')
      .insert([{ store_id, name, website: website || null, notes: notes || null }])
      .select()
      .single();

    if (error) throw error;
    res.json({ distributor: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update distributor info (admin only)
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, website, notes } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name;
    if (website !== undefined) updates.website = website;
    if (notes !== undefined) updates.notes = notes;

    const { data, error } = await supabase
      .from('distributors')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ distributor: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk upsert prices for a distributor (admin only)
// Body: { prices: [{ item_id, unit_cost }] }
router.put('/:id/prices', auth, adminOnly, async (req, res) => {
  try {
    const { prices } = req.body;
    if (!prices || prices.length === 0) return res.status(400).json({ error: 'prices required' });

    const { data: dist } = await supabase
      .from('distributors')
      .select('store_id')
      .eq('id', req.params.id)
      .single();

    if (!dist) return res.status(404).json({ error: 'Distributor not found' });

    const upsertData = prices
      .filter(p => p.item_id)
      .map(p => ({
        distributor_id: req.params.id,
        store_id: dist.store_id,
        item_id: p.item_id,
        unit_cost: Math.round((parseFloat(p.unit_cost) || 0) * 100) / 100,
        updated_at: new Date().toISOString()
      }));

    const { error } = await supabase
      .from('distributor_prices')
      .upsert(upsertData, { onConflict: 'distributor_id,item_id,store_id' });

    if (error) throw error;

    // For each item that got a non-zero price, check if we now have a new cheapest
    // price and if so update inventory_items.cost + push to Clover
    const itemsWithPrices = upsertData.filter(p => p.unit_cost > 0);
    if (itemsWithPrices.length > 0) {
      // Load store credentials once
      const { data: store } = await supabase
        .from('stores').select('*').eq('id', dist.store_id).single();

      for (const p of itemsWithPrices) {
        try {
          // Get ALL distributor prices for this item + store to find global cheapest
          const { data: allPrices } = await supabase
            .from('distributor_prices')
            .select('unit_cost')
            .eq('item_id', p.item_id)
            .eq('store_id', dist.store_id)
            .gt('unit_cost', 0);

          if (!allPrices || allPrices.length === 0) continue;
          const cheapest = Math.min(...allPrices.map(x => x.unit_cost));

          // Get current inventory cost
          const { data: invItem } = await supabase
            .from('inventory_items')
            .select('cost, price')
            .eq('id', p.item_id)
            .eq('store_id', dist.store_id)
            .single();

          if (!invItem || invItem.cost === cheapest) continue;

          // Update inventory cost in Supabase
          await supabase
            .from('inventory_items')
            .update({ cost: cheapest })
            .eq('id', p.item_id)
            .eq('store_id', dist.store_id);

          // Push cost to Clover (keep existing selling price)
          if (store) {
            await updateItemPriceAndCost(
              store.merchant_id,
              store.api_token,
              p.item_id,
              invItem.price || 0,
              cheapest
            );
          }
        } catch (syncErr) {
          console.error('Cost sync error for item', p.item_id, syncErr.message);
          // Don't fail the whole request — log and continue
        }
      }
    }

    res.json({ success: true, updated: upsertData.length });
  } catch (err) {
    console.error('Upsert prices error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete distributor (admin only) — cascades to prices
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { error } = await supabase
      .from('distributors')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
