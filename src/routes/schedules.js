const express = require('express');
const router = express.Router();
const axios = require('axios');
const supabase = require('../lib/supabase');
const auth = require('../middleware/auth');

const CLOVER_BASE = 'https://api.clover.com/v3/merchants/';

function cloverHeaders(token) {
  return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
}

// Get target items with price + name. Note: inventory_items.id IS the Clover item ID.
async function getTargetItems(storeId, targetType, targetIds) {
  let query = supabase.from('inventory_items')
    .select('id, price, variant_name')
    .eq('store_id', storeId);

  if (targetType === 'category') query = query.in('category', targetIds);
  else if (targetType === 'item_group') query = query.in('group_name', targetIds);
  else query = query.in('id', targetIds);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// Calculate discounted price (returns dollars)
function calcDiscountedPrice(originalPrice, discountType, discountValue) {
  let p = discountType === 'percent'
    ? originalPrice * (1 - discountValue / 100)
    : originalPrice - discountValue;
  return Math.max(0, Math.round(p * 100) / 100);
}

// Update name + price for a single Clover item
async function setCloverItem(merchantId, apiToken, cloverItemId, name, priceDollars) {
  await axios.post(
    `${CLOVER_BASE}${merchantId}/items/${cloverItemId}`,
    { name, price: Math.round(priceDollars * 100) },
    { headers: cloverHeaders(apiToken) }
  );
}

// Restore original name + price from our DB to Clover
async function restoreCloverItems(store, storeId, appliedItemIds) {
  if (!appliedItemIds?.length) return;
  const { data: items } = await supabase
    .from('inventory_items')
    .select('id, price, variant_name')
    .in('id', appliedItemIds)
    .eq('store_id', storeId);

  for (const item of items || []) {
    if (!item.price) continue;
    try {
      await setCloverItem(store.merchant_id, store.api_token, item.id, item.variant_name, item.price);
    } catch (err) {
      console.error(`Failed to restore item ${item.id}:`, err.message);
    }
  }
}

// Check for conflicts: items already in another active schedule
async function checkConflicts(storeId, targetType, targetIds, excludeScheduleId = null) {
  const { data: active } = await supabase
    .from('discount_schedules')
    .select('id, name, target_type, target_ids')
    .eq('store_id', storeId)
    .in('status', ['scheduled', 'active'])
    .neq('id', excludeScheduleId || '00000000-0000-0000-0000-000000000000');

  if (!active || active.length === 0) return [];

  const newItems = await getTargetItems(storeId, targetType, targetIds);
  const newItemIds = new Set(newItems.map(i => i.id));

  const conflicts = [];
  for (const sched of active) {
    const existItems = await getTargetItems(storeId, sched.target_type, sched.target_ids);
    const existItemIds = new Set(existItems.map(i => i.id));

    const overlap = [...newItemIds].filter(id => existItemIds.has(id));
    if (overlap.length > 0) {
      conflicts.push({ schedule: sched.name, overlappingCount: overlap.length });
    }
  }
  return conflicts;
}

// GET /api/schedules — list for a store
router.get('/', auth, async (req, res) => {
  try {
    const { store_id } = req.query;
    if (!store_id) return res.status(400).json({ error: 'store_id required' });

    const { data, error } = await supabase
      .from('discount_schedules')
      .select('*')
      .eq('store_id', store_id)
      .order('start_date', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/schedules — create
router.post('/', auth, async (req, res) => {
  try {
    const { store_id, name, discount_type, discount_value, start_date, end_date, target_type, target_ids, force } = req.body;

    if (!store_id || !name || !discount_type || !discount_value || !start_date || !end_date || !target_type || !target_ids?.length) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Conflict check
    if (!force) {
      const conflicts = await checkConflicts(store_id, target_type, target_ids);
      if (conflicts.length > 0) {
        return res.status(409).json({ conflicts, message: 'Some items already have an active discount schedule.' });
      }
    }

    const { data: schedule, error } = await supabase
      .from('discount_schedules')
      .insert({ store_id, name, discount_type, discount_value, start_date, end_date, target_type, target_ids, status: 'scheduled' })
      .select()
      .single();

    if (error) throw error;

    // If start_date is today or in the past and end_date is today or future, activate immediately
    const today = new Date().toISOString().split('T')[0];
    if (start_date <= today && end_date >= today) {
      await activateSchedule(schedule);
    }

    res.json({ success: true, schedule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/schedules/:id — edit (only name/dates/value if not yet active)
router.put('/:id', auth, async (req, res) => {
  try {
    const { name, discount_type, discount_value, start_date, end_date, target_type, target_ids } = req.body;

    const { data: existing } = await supabase.from('discount_schedules').select('*').eq('id', req.params.id).single();
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const updates = { name, discount_type, discount_value, start_date, end_date, target_type, target_ids, updated_at: new Date().toISOString() };
    const { data, error } = await supabase.from('discount_schedules').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;

    res.json({ success: true, schedule: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/schedules/:id/cancel — soft cancel (restore Clover, keep record)
router.put('/:id/cancel', auth, async (req, res) => {
  try {
    const { data: schedule } = await supabase.from('discount_schedules').select('*').eq('id', req.params.id).single();
    if (!schedule) return res.status(404).json({ error: 'Not found' });

    if (schedule.status === 'active' && schedule.applied_item_ids?.length) {
      const { data: store } = await supabase.from('stores').select('merchant_id, api_token').eq('id', schedule.store_id).single();
      if (store?.merchant_id && store?.api_token) {
        await restoreCloverItems(store, schedule.store_id, schedule.applied_item_ids);
      }
    }

    await supabase.from('discount_schedules').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/schedules/:id — hard delete (restore Clover if active, then remove record)
router.delete('/:id', auth, async (req, res) => {
  try {
    const { data: schedule } = await supabase.from('discount_schedules').select('*').eq('id', req.params.id).single();
    if (!schedule) return res.status(404).json({ error: 'Not found' });

    if (schedule.status === 'active' && schedule.applied_item_ids?.length) {
      const { data: store } = await supabase.from('stores').select('merchant_id, api_token').eq('id', schedule.store_id).single();
      if (store?.merchant_id && store?.api_token) {
        await restoreCloverItems(store, schedule.store_id, schedule.applied_item_ids);
      }
    }

    const { error } = await supabase.from('discount_schedules').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Activate: update Clover item prices to discounted prices
async function activateSchedule(schedule) {
  try {
    const { data: store } = await supabase.from('stores').select('merchant_id, api_token').eq('id', schedule.store_id).single();
    if (!store?.merchant_id || !store?.api_token) return;

    const items = await getTargetItems(schedule.store_id, schedule.target_type, schedule.target_ids);
    if (items.length === 0) {
      await supabase.from('discount_schedules').update({ status: 'active', applied_item_ids: [], updated_at: new Date().toISOString() }).eq('id', schedule.id);
      return;
    }

    const applied = [];
    for (const item of items) {
      if (!item.price) continue;
      const discountedPrice = calcDiscountedPrice(item.price, schedule.discount_type, schedule.discount_value);
      const saleName = `${schedule.name} (${item.variant_name})`;
      try {
        await setCloverItem(store.merchant_id, store.api_token, item.id, saleName, discountedPrice);
        applied.push(item.id);
      } catch (err) {
        console.error(`Failed to set sale price for item ${item.id}:`, err.message);
      }
    }

    await supabase.from('discount_schedules').update({
      status: 'active',
      applied_item_ids: applied,
      updated_at: new Date().toISOString()
    }).eq('id', schedule.id);

    console.log(`Activated schedule "${schedule.name}" — ${applied.length} items price-updated on Clover`);
  } catch (err) {
    console.error(`Failed to activate schedule ${schedule.id}:`, err.message);
  }
}

// Expire: restore original prices from our DB
async function expireSchedule(schedule) {
  try {
    if (schedule.applied_item_ids?.length) {
      const { data: store } = await supabase.from('stores').select('merchant_id, api_token').eq('id', schedule.store_id).single();
      if (store?.merchant_id && store?.api_token) {
        await restoreCloverItems(store, schedule.store_id, schedule.applied_item_ids);
      }
    }
    await supabase.from('discount_schedules').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', schedule.id);
    console.log(`Expired schedule "${schedule.name}" — prices restored`);
  } catch (err) {
    console.error(`Failed to expire schedule ${schedule.id}:`, err.message);
  }
}

// POST /api/schedules/run-cron — manually trigger or called by cron
router.post('/run-cron', async (req, res) => {
  try {
    await runCron();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function runCron() {
  const today = new Date().toISOString().split('T')[0];

  // Activate scheduled ones whose start_date has arrived
  const { data: toActivate } = await supabase
    .from('discount_schedules')
    .select('*')
    .eq('status', 'scheduled')
    .lte('start_date', today)
    .gte('end_date', today);

  for (const s of toActivate || []) {
    await activateSchedule(s);
  }

  // Expire active ones whose end_date has passed
  const { data: toExpire } = await supabase
    .from('discount_schedules')
    .select('*')
    .eq('status', 'active')
    .lt('end_date', today);

  for (const s of toExpire || []) {
    await expireSchedule(s);
  }
}

// Export runCron so index.js can schedule it
module.exports = router;
module.exports.runCron = runCron;
