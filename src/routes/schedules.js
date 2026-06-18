const express = require('express');
const router = express.Router();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const supabase = require('../lib/supabase');

const CLOVER_BASE = 'https://api.clover.com/v3/merchants/';

function cloverHeaders(token) {
  return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
}

// Auth middleware
async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  req.token = token;
  next();
}

// Resolve target_ids to Clover item IDs
async function resolveCloverItemIds(storeId, targetType, targetIds) {
  let query = supabase.from('inventory_items').select('clover_item_id, item_group, category').eq('store_id', storeId).not('clover_item_id', 'is', null);

  if (targetType === 'category') {
    query = query.in('category', targetIds);
  } else if (targetType === 'item_group') {
    query = query.in('item_group', targetIds);
  } else if (targetType === 'item') {
    query = query.in('id', targetIds);
  }

  const { data, error } = await query;
  if (error) throw error;
  return [...new Set((data || []).map(i => i.clover_item_id).filter(Boolean))];
}

// Create discount in Clover, attach to items, return { cloverDiscountId, appliedItemIds }
async function applyToClover(merchantId, apiToken, name, discountType, discountValue, cloverItemIds) {
  // Create the discount object
  const discountPayload = { name };
  if (discountType === 'percent') {
    discountPayload.percentage = Math.round(discountValue * 10); // Clover uses tenths of a percent
  } else {
    discountPayload.amount = Math.round(discountValue * 100); // Clover uses cents
  }

  const createRes = await axios.post(
    `${CLOVER_BASE}${merchantId}/discounts`,
    discountPayload,
    { headers: cloverHeaders(apiToken) }
  );
  const cloverDiscountId = createRes.data.id;

  // Attach discount to each item
  const applied = [];
  for (const itemId of cloverItemIds) {
    try {
      await axios.post(
        `${CLOVER_BASE}${merchantId}/items/${itemId}/discounts`,
        { id: cloverDiscountId },
        { headers: cloverHeaders(apiToken) }
      );
      applied.push(itemId);
    } catch (err) {
      console.error(`Failed to attach discount to item ${itemId}:`, err.message);
    }
  }

  return { cloverDiscountId, appliedItemIds: applied };
}

// Remove discount from all items and delete from Clover
async function removeFromClover(merchantId, apiToken, cloverDiscountId, appliedItemIds) {
  for (const itemId of appliedItemIds) {
    try {
      await axios.delete(
        `${CLOVER_BASE}${merchantId}/items/${itemId}/discounts/${cloverDiscountId}`,
        { headers: cloverHeaders(apiToken) }
      );
    } catch (err) {
      console.error(`Failed to remove discount from item ${itemId}:`, err.message);
    }
  }
  try {
    await axios.delete(
      `${CLOVER_BASE}${merchantId}/discounts/${cloverDiscountId}`,
      { headers: cloverHeaders(apiToken) }
    );
  } catch (err) {
    console.error(`Failed to delete Clover discount ${cloverDiscountId}:`, err.message);
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

  // Get inventory item IDs for the new schedule's targets
  let newQuery = supabase.from('inventory_items').select('id, name, item_group, category').eq('store_id', storeId);
  if (targetType === 'category') newQuery = newQuery.in('category', targetIds);
  else if (targetType === 'item_group') newQuery = newQuery.in('item_group', targetIds);
  else if (targetType === 'item') newQuery = newQuery.in('id', targetIds);
  const { data: newItems } = await newQuery;
  const newItemIds = new Set((newItems || []).map(i => i.id));

  const conflicts = [];
  for (const sched of active) {
    let existQuery = supabase.from('inventory_items').select('id').eq('store_id', storeId);
    if (sched.target_type === 'category') existQuery = existQuery.in('category', sched.target_ids);
    else if (sched.target_type === 'item_group') existQuery = existQuery.in('item_group', sched.target_ids);
    else if (sched.target_type === 'item') existQuery = existQuery.in('id', sched.target_ids);
    const { data: existItems } = await existQuery;
    const existItemIds = new Set((existItems || []).map(i => i.id));

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

// DELETE /api/schedules/:id — cancel
router.delete('/:id', auth, async (req, res) => {
  try {
    const { data: schedule } = await supabase.from('discount_schedules').select('*').eq('id', req.params.id).single();
    if (!schedule) return res.status(404).json({ error: 'Not found' });

    // Remove from Clover if active
    if (schedule.status === 'active' && schedule.clover_discount_id) {
      const { data: store } = await supabase.from('stores').select('clover_merchant_id, clover_api_token').eq('id', schedule.store_id).single();
      if (store?.clover_merchant_id && store?.clover_api_token) {
        await removeFromClover(store.clover_merchant_id, store.clover_api_token, schedule.clover_discount_id, schedule.applied_item_ids || []);
      }
    }

    await supabase.from('discount_schedules').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Activate a schedule (called by cron or immediately on create)
async function activateSchedule(schedule) {
  try {
    const { data: store } = await supabase.from('stores').select('clover_merchant_id, clover_api_token').eq('id', schedule.store_id).single();
    if (!store?.clover_merchant_id || !store?.clover_api_token) return;

    const cloverItemIds = await resolveCloverItemIds(schedule.store_id, schedule.target_type, schedule.target_ids);
    if (cloverItemIds.length === 0) {
      await supabase.from('discount_schedules').update({ status: 'active', applied_item_ids: [], updated_at: new Date().toISOString() }).eq('id', schedule.id);
      return;
    }

    const { cloverDiscountId, appliedItemIds } = await applyToClover(
      store.clover_merchant_id, store.clover_api_token,
      schedule.name, schedule.discount_type, schedule.discount_value, cloverItemIds
    );

    await supabase.from('discount_schedules').update({
      status: 'active',
      clover_discount_id: cloverDiscountId,
      applied_item_ids: appliedItemIds,
      updated_at: new Date().toISOString()
    }).eq('id', schedule.id);

    console.log(`Activated discount schedule "${schedule.name}" — ${appliedItemIds.length} items`);
  } catch (err) {
    console.error(`Failed to activate schedule ${schedule.id}:`, err.message);
  }
}

// Expire a schedule (called by cron)
async function expireSchedule(schedule) {
  try {
    if (schedule.clover_discount_id) {
      const { data: store } = await supabase.from('stores').select('clover_merchant_id, clover_api_token').eq('id', schedule.store_id).single();
      if (store?.clover_merchant_id && store?.clover_api_token) {
        await removeFromClover(store.clover_merchant_id, store.clover_api_token, schedule.clover_discount_id, schedule.applied_item_ids || []);
      }
    }
    await supabase.from('discount_schedules').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', schedule.id);
    console.log(`Expired discount schedule "${schedule.name}"`);
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
