const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');
const { setStockInClover } = require('../services/clover');
const { logActivity } = require('../services/notify');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Get next PO number for a distributor + store
async function getNextPONumber(storeId, distributor) {
  const clean = distributor.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().substring(0, 6);
  const { data } = await supabase
    .from('purchase_orders')
    .select('po_number')
    .eq('store_id', storeId)
    .ilike('po_number', `${clean}%`)
    .order('created_at', { ascending: false });

  let maxNum = 0;
  (data || []).forEach(row => {
    const m = row.po_number.match(/(\d+)$/);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1]));
  });
  return `${clean}${String(maxNum + 1).padStart(3, '0')}`;
}

// List POs for a store
router.get('/', auth, async (req, res) => {
  try {
    const { store_id } = req.query;

    let query = supabase
      .from('purchase_orders')
      .select('*')
      .order('created_at', { ascending: false });

    if (store_id) {
      if (req.user.role === 'manager' && req.user.store_id !== store_id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      query = query.eq('store_id', store_id);
    } else if (req.user.role === 'manager') {
      query = query.eq('store_id', req.user.store_id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ pos: data });
  } catch (err) {
    console.error('List POs error:', err);
    res.status(500).json({ error: 'Failed to load purchase orders' });
  }
});

// Get single PO with items
router.get('/:id', auth, async (req, res) => {
  try {
    const { data: po, error: poError } = await supabase
      .from('purchase_orders')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (poError || !po) return res.status(404).json({ error: 'PO not found' });

    if (req.user.role === 'manager' && po.store_id !== req.user.store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: items, error: itemsError } = await supabase
      .from('purchase_order_items')
      .select('*')
      .eq('po_id', req.params.id)
      .order('category')
      .order('group_name')
      .order('variant_name');

    if (itemsError) throw itemsError;
    res.json({ po, items: items || [] });
  } catch (err) {
    console.error('Get PO error:', err);
    res.status(500).json({ error: 'Failed to load purchase order' });
  }
});

// Create new PO
router.post('/', auth, async (req, res) => {
  try {
    const { store_id, distributor, items, from_suggested } = req.body;

    if (!store_id || !distributor || !items || items.length === 0) {
      return res.status(400).json({ error: 'store_id, distributor, and items are required' });
    }

    if (req.user.role === 'manager' && req.user.store_id !== store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const poNumber = await getNextPONumber(store_id, distributor);
    const totalCost = items.reduce((sum, item) => sum + (item.unit_cost * item.ordered_qty), 0);

    const { data: po, error: poError } = await supabase
      .from('purchase_orders')
      .insert([{
        store_id,
        po_number: poNumber,
        distributor,
        status: 'ordered',
        total_cost: Math.round(totalCost * 100) / 100,
        remaining_balance: Math.round(totalCost * 100) / 100
      }])
      .select()
      .single();

    if (poError) throw poError;

    // Insert line items
    const lineItems = items.map(item => ({
      po_id: po.id,
      item_id: item.item_id,
      category: item.category || '',
      group_name: item.group_name || '',
      variant_name: item.variant_name || '',
      unit_cost: item.unit_cost || 0,
      unit_price: item.unit_price || 0,
      ordered_qty: item.ordered_qty || 0,
      received_qty: 0,
      remaining_qty: item.ordered_qty || 0
    }));

    const { error: itemsError } = await supabase
      .from('purchase_order_items')
      .insert(lineItems);

    if (itemsError) throw itemsError;

    // If created from suggested orders, clear suggested_order on those items
    if (from_suggested) {
      const itemIds = items.map(i => i.item_id);
      await supabase
        .from('inventory_items')
        .update({ suggested_order: 0 })
        .in('id', itemIds)
        .eq('store_id', store_id);
    }

    await logActivity({
      actor: req.user,
      action: 'po.create',
      description: `Created PO ${po.po_number} (${distributor}) — ${items.length} item${items.length !== 1 ? 's' : ''}, est. $${po.total_cost.toFixed(2)}`,
      store_id,
      metadata: { po_id: po.id, total_cost: po.total_cost }
    });

    res.json({ po });
  } catch (err) {
    console.error('Create PO error:', err);
    res.status(500).json({ error: err.message || 'Failed to create purchase order' });
  }
});

// Update PO (status, notes, distributor)
router.put('/:id', auth, async (req, res) => {
  try {
    const { status, notes, distributor } = req.body;

    const { data: existing } = await supabase
      .from('purchase_orders')
      .select('store_id')
      .eq('id', req.params.id)
      .single();

    if (!existing) return res.status(404).json({ error: 'PO not found' });
    if (req.user.role === 'manager' && existing.store_id !== req.user.store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updateData = { updated_at: new Date().toISOString() };
    if (status !== undefined) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;
    if (distributor !== undefined) updateData.distributor = distributor;

    const { data, error } = await supabase
      .from('purchase_orders')
      .update(updateData)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ po: data });
  } catch (err) {
    console.error('Update PO error:', err);
    res.status(500).json({ error: 'Failed to update purchase order' });
  }
});

// Receive items on a PO (partial or full)
// Body: { items: [{ id: <po_item_id>, received_qty: N }] }
router.post('/:id/receive', auth, async (req, res) => {
  try {
    const { items: receivedItems } = req.body;
    if (!receivedItems || receivedItems.length === 0) {
      return res.status(400).json({ error: 'items required' });
    }

    // Load PO + store for Clover access
    const { data: po } = await supabase
      .from('purchase_orders')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (req.user.role === 'manager' && po.store_id !== req.user.store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: store } = await supabase
      .from('stores')
      .select('*')
      .eq('id', po.store_id)
      .single();

    // Load all PO items
    const { data: allItems } = await supabase
      .from('purchase_order_items')
      .select('*')
      .eq('po_id', req.params.id);

    let newRemainingBalance = 0;
    let anyStillRemaining = false;

    for (const poItem of allItems) {
      const incomingReceive = receivedItems.find(r => r.id === poItem.id);
      let updatedReceived = poItem.received_qty;
      let updatedRemaining = poItem.remaining_qty;

      if (incomingReceive && incomingReceive.received_qty > 0) {
        const qty = Math.min(incomingReceive.received_qty, poItem.remaining_qty);
        updatedReceived = poItem.received_qty + qty;
        updatedRemaining = poItem.remaining_qty - qty;

        // Push to Clover: add received qty on top of current stock
        if (store && qty > 0) {
          try {
            const { data: invItem } = await supabase
              .from('inventory_items')
              .select('clover_qty')
              .eq('id', poItem.item_id)
              .eq('store_id', po.store_id)
              .single();

            const currentQty = invItem ? (invItem.clover_qty || 0) : 0;
            const newQty = currentQty + qty;

            await setStockInClover(store.merchant_id, store.api_token, poItem.item_id, newQty);
            await supabase
              .from('inventory_items')
              .update({ clover_qty: newQty })
              .eq('id', poItem.item_id)
              .eq('store_id', po.store_id);
          } catch (cloverErr) {
            console.error('Clover update error for item', poItem.item_id, cloverErr.message);
          }
        }

        await supabase
          .from('purchase_order_items')
          .update({ received_qty: updatedReceived, remaining_qty: updatedRemaining })
          .eq('id', poItem.id);
      }

      if (updatedRemaining > 0) {
        anyStillRemaining = true;
        newRemainingBalance += updatedRemaining * poItem.unit_cost;
      }
    }

    // Update PO status and remaining balance
    const newStatus = anyStillRemaining ? 'partial' : 'received';
    await supabase
      .from('purchase_orders')
      .update({
        status: newStatus,
        remaining_balance: Math.round(newRemainingBalance * 100) / 100,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id);

    res.json({ success: true, status: newStatus });
  } catch (err) {
    console.error('Receive PO error:', err);
    res.status(500).json({ error: 'Failed to receive purchase order' });
  }
});

// Update a PO line item's ordered qty
router.put('/:id/items/:itemId', auth, async (req, res) => {
  try {
    const { ordered_qty } = req.body;

    const { data: po } = await supabase.from('purchase_orders').select('*').eq('id', req.params.id).single();
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (req.user.role === 'manager' && po.store_id !== req.user.store_id) return res.status(403).json({ error: 'Access denied' });

    const { data: poItem } = await supabase
      .from('purchase_order_items').select('*')
      .eq('id', req.params.itemId).eq('po_id', req.params.id).single();
    if (!poItem) return res.status(404).json({ error: 'Item not found' });

    // Can't set ordered qty below what's already received
    const newOrdered = Math.max(poItem.received_qty, parseInt(ordered_qty) || 0);
    const newRemaining = newOrdered - poItem.received_qty;

    await supabase.from('purchase_order_items')
      .update({ ordered_qty: newOrdered, remaining_qty: newRemaining })
      .eq('id', req.params.itemId);

    // Recalculate PO totals using updated values
    const { data: allPOItems } = await supabase.from('purchase_order_items').select('*').eq('po_id', req.params.id);
    const newTotal = (allPOItems || []).reduce((sum, i) => {
      const qty = i.id === req.params.itemId ? newOrdered : i.ordered_qty;
      return sum + qty * i.unit_cost;
    }, 0);
    const newBalance = (allPOItems || []).reduce((sum, i) => {
      const rem = i.id === req.params.itemId ? newRemaining : i.remaining_qty;
      return sum + rem * i.unit_cost;
    }, 0);

    await supabase.from('purchase_orders').update({
      total_cost: Math.round(newTotal * 100) / 100,
      remaining_balance: Math.round(newBalance * 100) / 100,
      updated_at: new Date().toISOString()
    }).eq('id', req.params.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Update PO item error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Remove a PO line item
router.delete('/:id/items/:itemId', auth, async (req, res) => {
  try {
    const { data: po } = await supabase.from('purchase_orders').select('*').eq('id', req.params.id).single();
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (req.user.role === 'manager' && po.store_id !== req.user.store_id) return res.status(403).json({ error: 'Access denied' });

    const { data: poItem } = await supabase
      .from('purchase_order_items').select('*')
      .eq('id', req.params.itemId).eq('po_id', req.params.id).single();
    if (!poItem) return res.status(404).json({ error: 'Item not found' });
    if (poItem.received_qty > 0) return res.status(400).json({ error: 'Cannot remove an item that has already been partially received' });

    await supabase.from('purchase_order_items').delete().eq('id', req.params.itemId);

    // Recalculate PO totals
    const { data: remaining } = await supabase.from('purchase_order_items').select('*').eq('po_id', req.params.id);
    const newTotal = (remaining || []).reduce((sum, i) => sum + i.ordered_qty * i.unit_cost, 0);
    const newBalance = (remaining || []).reduce((sum, i) => sum + i.remaining_qty * i.unit_cost, 0);

    await supabase.from('purchase_orders').update({
      total_cost: Math.round(newTotal * 100) / 100,
      remaining_balance: Math.round(newBalance * 100) / 100,
      updated_at: new Date().toISOString()
    }).eq('id', req.params.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Remove PO item error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add items to an existing PO
router.post('/:id/items', auth, async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'items required' });
    }

    const { data: po } = await supabase
      .from('purchase_orders')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (req.user.role === 'manager' && po.store_id !== req.user.store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (po.status === 'received') {
      return res.status(400).json({ error: 'Cannot add items to a fully received PO' });
    }

    const lineItems = items.map(item => ({
      po_id: po.id,
      item_id: item.item_id,
      category: item.category || '',
      group_name: item.group_name || '',
      variant_name: item.variant_name || '',
      unit_cost: item.unit_cost || 0,
      unit_price: item.unit_price || 0,
      ordered_qty: item.ordered_qty || 0,
      received_qty: 0,
      remaining_qty: item.ordered_qty || 0
    }));

    const { error: itemsError } = await supabase
      .from('purchase_order_items')
      .insert(lineItems);

    if (itemsError) throw itemsError;

    const addedCost = items.reduce((sum, i) => sum + ((i.unit_cost || 0) * (i.ordered_qty || 0)), 0);
    await supabase
      .from('purchase_orders')
      .update({
        total_cost: Math.round(((po.total_cost || 0) + addedCost) * 100) / 100,
        remaining_balance: Math.round(((po.remaining_balance || 0) + addedCost) * 100) / 100,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Add items to PO error:', err);
    res.status(500).json({ error: err.message || 'Failed to add items' });
  }
});

// Delete/cancel a PO (push remaining qty back to suggested_order)
router.delete('/:id', auth, async (req, res) => {
  try {
    const { push_back } = req.query; // ?push_back=1 to restore suggested orders

    const { data: po } = await supabase
      .from('purchase_orders')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (req.user.role === 'manager' && po.store_id !== req.user.store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Optionally push remaining quantities back to suggested orders
    if (push_back === '1') {
      const { data: items } = await supabase
        .from('purchase_order_items')
        .select('*')
        .eq('po_id', req.params.id);

      for (const item of items || []) {
        if (item.remaining_qty > 0) {
          const { data: invItem } = await supabase
            .from('inventory_items')
            .select('suggested_order')
            .eq('id', item.item_id)
            .eq('store_id', po.store_id)
            .single();

          const current = invItem ? (invItem.suggested_order || 0) : 0;
          await supabase
            .from('inventory_items')
            .update({ suggested_order: current + item.remaining_qty })
            .eq('id', item.item_id)
            .eq('store_id', po.store_id);
        }
      }
    }

    const { error } = await supabase
      .from('purchase_orders')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    await logActivity({
      actor: req.user,
      action: 'po.delete',
      description: `Deleted PO ${po.po_number} (${po.distributor})${push_back === '1' ? ' — remaining qty pushed back to suggested orders' : ''}`,
      store_id: po.store_id
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete PO error:', err);
    res.status(500).json({ error: 'Failed to delete purchase order' });
  }
});

module.exports = router;
