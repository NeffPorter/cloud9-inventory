const express = require('express');
const router = express.Router();
const axios = require('axios');
const supabase = require('../lib/supabase');
const auth = require('../middleware/auth');
const { getValidApiToken } = require('../services/clover');

const CLOVER_BASE = 'https://api.clover.com/v3/merchants/';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function cloverHeaders(token) {
  return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
}

// Get target items with price + name. Note: inventory_items.id IS the Clover item ID.
async function getTargetItems(storeId, targetType, targetIds) {
  let query = supabase.from('inventory_items')
    .select('id, price, variant_name, group_name')
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

// Update price (and optionally name) for a single Clover item.
// name should be null for grouped items — Clover won't allow name changes on grouped items.
async function setCloverItem(merchantId, apiToken, cloverItemId, name, priceDollars) {
  const body = { price: Math.round(priceDollars * 100) };
  if (name) body.name = name;
  await axios.post(
    `${CLOVER_BASE}${merchantId}/items/${cloverItemId}`,
    body,
    { headers: cloverHeaders(apiToken) }
  );
}

// "20% OFF" or "$5 OFF"
function formatDiscountLabel(discountType, discountValue) {
  return discountType === 'percent' ? `${discountValue}% OFF` : `$${discountValue} OFF`;
}

// Grouped items can't have their own name changed, but the item GROUP's name can be —
// and Clover derives each grouped item's displayed/receipt name from the group name + its
// variant attribute. So renaming the group is how a sale gets flagged on the receipt for variants.
async function getCloverItemGroupId(merchantId, apiToken, cloverItemId) {
  const res = await axios.get(
    `${CLOVER_BASE}${merchantId}/items/${cloverItemId}?expand=itemGroup`,
    { headers: cloverHeaders(apiToken) }
  );
  return res.data?.itemGroup?.id || null;
}

async function renameCloverItemGroup(merchantId, apiToken, groupId, name) {
  await axios.post(
    `${CLOVER_BASE}${merchantId}/item_groups/${groupId}`,
    { name },
    { headers: cloverHeaders(apiToken) }
  );
}

// Restore item group names from a schedule's frozen group_renames snapshot
async function restoreCloverGroups(store, groupRenames, apiToken) {
  if (!groupRenames) return;
  const token = apiToken || store.api_token;
  for (const [groupName, info] of Object.entries(groupRenames)) {
    if (!info?.cloverGroupId || !info?.originalName) continue;
    try {
      await renameCloverItemGroup(store.merchant_id, token, info.cloverGroupId, info.originalName);
      await sleep(300);
    } catch (err) {
      console.error(`Failed to restore group name for ${groupName}:`, err.message);
    }
  }
}

// Restore original name + price to Clover.
// Always restore from the schedule's frozen original_prices snapshot when available —
// inventory_items.price can no longer be trusted once Clover syncs the discounted price back into our DB.
async function restoreCloverItems(store, storeId, appliedItemIds, originalPrices, apiToken) {
  if (!appliedItemIds?.length) return;
  const token = apiToken || store.api_token;
  const { data: items } = await supabase
    .from('inventory_items')
    .select('id, price, variant_name, group_name')
    .in('id', appliedItemIds)
    .eq('store_id', storeId);

  for (const item of items || []) {
    const snapshotPrice = originalPrices?.[item.id];
    const restorePrice = snapshotPrice !== undefined ? parseFloat(snapshotPrice) : (item.price ? parseFloat(item.price) : null);
    if (restorePrice === null || isNaN(restorePrice)) continue;
    // Only restore name for ungrouped items — Clover blocks name changes on grouped items
    const restoreName = item.group_name ? null : item.variant_name;
    try {
      await setCloverItem(store.merchant_id, token, item.id, restoreName, restorePrice);
      await sleep(300);
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
    const { store_id, name, discount_type, discount_value, start_date, end_date, target_type, target_ids, force, start_time, end_time, indefinite } = req.body;

    if (!store_id || !name || !discount_type || !discount_value || !start_date || !target_type || !target_ids?.length) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!indefinite && !end_date) {
      return res.status(400).json({ error: 'end_date required unless indefinite is true' });
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
      .insert({ store_id, name, discount_type, discount_value, start_date, end_date: indefinite ? null : end_date, target_type, target_ids, status: 'scheduled', start_time: start_time || null, end_time: end_time || null, indefinite: !!indefinite })
      .select()
      .single();

    if (error) throw error;

    // Activate immediately if within date range
    const today = new Date().toISOString().split('T')[0];
    if (start_date <= today && (indefinite || end_date >= today)) {
      await activateSchedule(schedule);
    }

    res.json({ success: true, schedule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/schedules/:id — edit
router.put('/:id', auth, async (req, res) => {
  try {
    const { name, discount_type, discount_value, start_date, end_date, target_type, target_ids, start_time, end_time, indefinite } = req.body;

    const { data: existing } = await supabase.from('discount_schedules').select('*').eq('id', req.params.id).single();
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const updates = {
      name, discount_type, discount_value, start_date,
      end_date: indefinite ? null : end_date,
      target_type, target_ids,
      start_time: start_time || null,
      end_time: end_time || null,
      indefinite: !!indefinite,
      updated_at: new Date().toISOString()
    };
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
      const { data: store } = await supabase.from('stores').select('merchant_id, api_token, refresh_token, token_expires_at').eq('id', schedule.store_id).single();
      if (store?.merchant_id && store?.api_token) {
        const apiToken = await getValidApiToken(store);
        await restoreCloverItems(store, schedule.store_id, schedule.applied_item_ids, schedule.original_prices, apiToken);
        await restoreCloverGroups(store, schedule.group_renames, apiToken);
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
      const { data: store } = await supabase.from('stores').select('merchant_id, api_token, refresh_token, token_expires_at').eq('id', schedule.store_id).single();
      if (store?.merchant_id && store?.api_token) {
        const apiToken = await getValidApiToken(store);
        await restoreCloverItems(store, schedule.store_id, schedule.applied_item_ids, schedule.original_prices, apiToken);
        await restoreCloverGroups(store, schedule.group_renames, apiToken);
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
// Returns { applied: [...], errors: [...], itemCount: n }
async function activateSchedule(schedule) {
  const result = { applied: [], errors: [], itemCount: 0 };
  try {
    const { data: store } = await supabase.from('stores').select('merchant_id, api_token, refresh_token, token_expires_at').eq('id', schedule.store_id).single();
    if (!store?.merchant_id || !store?.api_token) {
      result.errors.push('Store has no Clover credentials (merchant_id / api_token missing)');
      return result;
    }
    const apiToken = await getValidApiToken(store);

    const items = await getTargetItems(schedule.store_id, schedule.target_type, schedule.target_ids);
    result.itemCount = items.length;

    if (items.length === 0) {
      result.errors.push(`No inventory items found for ${schedule.target_type} [${(schedule.target_ids || []).join(', ')}] in this store`);
      await supabase.from('discount_schedules').update({ status: 'active', applied_item_ids: [], updated_at: new Date().toISOString() }).eq('id', schedule.id);
      return result;
    }

    // Freeze each item's pre-discount price the FIRST time we ever touch it.
    // Once Clover syncs the discounted price back into inventory_items.price, that column can no
    // longer be trusted as "the original price" — re-applying/retrying must always discount from
    // this frozen snapshot, never from the live (possibly already-discounted) DB price.
    const originalPrices = { ...(schedule.original_prices || {}) };
    let snapshotChanged = false;
    for (const item of items) {
      if (originalPrices[item.id] === undefined && item.price) {
        originalPrices[item.id] = parseFloat(item.price);
        snapshotChanged = true;
      }
    }
    if (snapshotChanged) {
      await supabase.from('discount_schedules').update({ original_prices: originalPrices }).eq('id', schedule.id);
    }

    const discountLabel = formatDiscountLabel(schedule.discount_type, schedule.discount_value);

    // Grouped items can't be renamed individually, but Clover derives each grouped item's
    // displayed name from its item GROUP's name — so rename the group instead. Freeze the
    // original group name + Clover group id the first time, like we do for prices.
    const uniqueGroups = [...new Set(items.filter(i => i.group_name).map(i => i.group_name))];
    const groupRenames = { ...(schedule.group_renames || {}) };
    let groupRenamesChanged = false;
    for (const groupName of uniqueGroups) {
      if (!groupRenames[groupName]) {
        const sampleItem = items.find(i => i.group_name === groupName);
        await sleep(300); // space out group ID lookups to avoid 429
        let cloverGroupId = null;
        try {
          cloverGroupId = await getCloverItemGroupId(store.merchant_id, apiToken, sampleItem.id);
        } catch (err) {
          if (err.response?.status === 429) {
            await sleep(2500);
            try {
              cloverGroupId = await getCloverItemGroupId(store.merchant_id, apiToken, sampleItem.id);
            } catch (retryErr) {
              result.errors.push(`Group ID lookup rate-limited for "${groupName}" — names may not update`);
              console.error(`Group ID lookup for ${groupName} failed after 429 retry:`, retryErr.message);
            }
          } else {
            result.errors.push(`Group ID lookup failed for "${groupName}": ${err.message}`);
            console.error(`Failed to look up item group for ${groupName}:`, err.message);
          }
        }
        if (cloverGroupId) {
          groupRenames[groupName] = { cloverGroupId, originalName: groupName };
          groupRenamesChanged = true;
        }
      }
    }
    if (groupRenamesChanged) {
      await supabase.from('discount_schedules').update({ group_renames: groupRenames }).eq('id', schedule.id);
    }
    for (const groupName of uniqueGroups) {
      const info = groupRenames[groupName];
      if (!info?.cloverGroupId) continue;
      const newGroupName = `${schedule.name} ${discountLabel} - ${info.originalName}`.slice(0, 127);
      try {
        await renameCloverItemGroup(store.merchant_id, apiToken, info.cloverGroupId, newGroupName);
        await sleep(300);
      } catch (err) {
        const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        result.errors.push(`Group rename failed for "${groupName}": ${detail}`);
        console.error(`Failed to rename item group ${groupName}:`, detail);
      }
    }

    // Track which groups actually got a Clover group ID so we can fall back to item-level rename for the rest
    const groupsWithCloverGroup = new Set(
      Object.keys(groupRenames).filter(g => groupRenames[g]?.cloverGroupId)
    );

    for (const item of items) {
      const basePrice = originalPrices[item.id];
      if (basePrice === undefined) { result.errors.push(`Item ${item.id} (${item.variant_name}) skipped — no price set`); continue; }
      const discountedPrice = calcDiscountedPrice(basePrice, schedule.discount_type, schedule.discount_value);
      const displayName = item.variant_name || item.id;
      // Use direct item name unless the group was successfully renamed via Clover group rename API
      const canRenameViaGroup = item.group_name && groupsWithCloverGroup.has(item.group_name);
      const saleName = canRenameViaGroup ? null : `${schedule.name} ${discountLabel} - ${displayName}`;
      try {
        await setCloverItem(store.merchant_id, apiToken, item.id, saleName, discountedPrice);
        result.applied.push(item.id);
        await sleep(300);
      } catch (err) {
        if (err.response?.status === 429) {
          await sleep(2000);
          try {
            await setCloverItem(store.merchant_id, apiToken, item.id, saleName, discountedPrice);
            result.applied.push(item.id);
            await sleep(300);
          } catch (retryErr) {
            const detail = retryErr.response?.data ? JSON.stringify(retryErr.response.data) : retryErr.message;
            result.errors.push(`Item ${item.variant_name} (${item.id}): ${detail}`);
            console.error(`Failed after retry for item ${item.id}:`, detail);
          }
        } else {
          const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
          result.errors.push(`Item ${item.variant_name} (${item.id}): ${detail}`);
          console.error(`Failed to set sale price for item ${item.id}:`, detail);
        }
      }
    }

    await supabase.from('discount_schedules').update({
      status: 'active',
      applied_item_ids: result.applied,
      updated_at: new Date().toISOString()
    }).eq('id', schedule.id);

    console.log(`Activated schedule "${schedule.name}" — ${result.applied.length}/${items.length} items updated on Clover`);
  } catch (err) {
    result.errors.push(err.message);
    console.error(`Failed to activate schedule ${schedule.id}:`, err.message);
  }
  return result;
}

async function expireSchedule(schedule) {
  try {
    if (schedule.applied_item_ids?.length) {
      const { data: store } = await supabase.from('stores').select('merchant_id, api_token, refresh_token, token_expires_at').eq('id', schedule.store_id).single();
      if (store?.merchant_id && store?.api_token) {
        const apiToken = await getValidApiToken(store);
        await restoreCloverItems(store, schedule.store_id, schedule.applied_item_ids, schedule.original_prices, apiToken);
        await restoreCloverGroups(store, schedule.group_renames, apiToken);
      }
    }
    await supabase.from('discount_schedules').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', schedule.id);
    console.log(`Expired schedule "${schedule.name}" — prices restored`);
  } catch (err) {
    console.error(`Failed to expire schedule ${schedule.id}:`, err.message);
  }
}

router.post('/:id/apply', auth, async (req, res) => {
  try {
    const { data: schedule } = await supabase.from('discount_schedules').select('*').eq('id', req.params.id).single();
    if (!schedule) return res.status(404).json({ error: 'Not found' });
    await supabase.from('discount_schedules').update({ status: 'scheduled', applied_item_ids: [] }).eq('id', req.params.id);
    const result = await activateSchedule({ ...schedule, status: 'scheduled', applied_item_ids: [] });
    const { data: updated } = await supabase.from('discount_schedules').select('*').eq('id', req.params.id).single();
    res.json({ success: true, schedule: updated, applied: result.applied, errors: result.errors, itemCount: result.itemCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/run-cron', auth, async (req, res) => {
  if (!['him', 'regional_manager', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin only' });
  }
  try {
    await runCron();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore prices for an indefinite schedule but set status back to 'scheduled' (so it re-activates next cycle)
async function restoreForIndefinite(schedule) {
  try {
    if (schedule.applied_item_ids?.length) {
      const { data: store } = await supabase.from('stores').select('merchant_id, api_token, refresh_token, token_expires_at').eq('id', schedule.store_id).single();
      if (store?.merchant_id && store?.api_token) {
        const apiToken = await getValidApiToken(store);
        await restoreCloverItems(store, schedule.store_id, schedule.applied_item_ids, schedule.original_prices, apiToken);
        await restoreCloverGroups(store, schedule.group_renames, apiToken);
      }
    }
    await supabase.from('discount_schedules').update({
      status: 'scheduled',
      applied_item_ids: [],
      updated_at: new Date().toISOString()
    }).eq('id', schedule.id);
    console.log(`Reset indefinite schedule "${schedule.name}" — prices restored, will re-activate next cycle`);
  } catch (err) {
    console.error(`Failed to reset indefinite schedule ${schedule.id}:`, err.message);
  }
}

async function runCron() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const currentTime = now.toTimeString().slice(0, 5); // "HH:MM"

  // Activate scheduled discounts whose date window (and optional time window) has started
  const { data: toActivate } = await supabase.from('discount_schedules')
    .select('*').eq('status', 'scheduled').lte('start_date', today)
    .or(`end_date.gte.${today},indefinite.eq.true`);

  for (const s of toActivate || []) {
    const st = s.start_time ? s.start_time.slice(0, 5) : null;
    const et = s.end_time   ? s.end_time.slice(0, 5)   : null;
    if (st && currentTime < st) continue;  // not yet time
    if (et && currentTime >= et) continue; // already past window
    await activateSchedule(s);
  }

  // Retry active schedules that lost applied items
  const { data: toRetry } = await supabase.from('discount_schedules')
    .select('*').eq('status', 'active').lte('start_date', today)
    .or(`end_date.gte.${today},indefinite.eq.true`);

  for (const s of toRetry || []) {
    const et = s.end_time ? s.end_time.slice(0, 5) : null;
    // If past end_time today: restore prices (indefinite → 'scheduled', finite → 'expired')
    if (et && currentTime >= et) {
      if (s.indefinite) await restoreForIndefinite(s);
      else if (s.end_date === today) await expireSchedule(s);
      continue;
    }
    if (!s.applied_item_ids || s.applied_item_ids.length === 0) { await activateSchedule(s); }
  }

  // Expire non-indefinite active schedules whose end_date has passed
  const { data: toExpire } = await supabase.from('discount_schedules')
    .select('*').eq('status', 'active').eq('indefinite', false).lt('end_date', today);

  for (const s of toExpire || []) { await expireSchedule(s); }
}

// GET /api/schedules/:id/report — sales summary for discounted items during the schedule period
router.get('/:id/report', auth, async (req, res) => {
  try {
    const { data: schedule } = await supabase.from('discount_schedules').select('*').eq('id', req.params.id).single();
    if (!schedule) return res.status(404).json({ error: 'Not found' });

    const items = await getTargetItems(schedule.store_id, schedule.target_type, schedule.target_ids);
    const itemIdSet = new Set(items.map(i => i.id));

    const startIso = schedule.start_date + 'T00:00:00.000Z';
    const endIso   = schedule.end_date ? (schedule.end_date + 'T23:59:59.999Z') : new Date().toISOString();

    const { data: sales } = await supabase.from('sales_log')
      .select('item_summary, type, net')
      .eq('store_id', schedule.store_id)
      .gte('created_at', startIso)
      .lte('created_at', endIso);

    // Parse item_summary: "itemId x qty, ..."
    const unitsSold = {};
    (sales || []).forEach(row => {
      if (!row.item_summary || row.item_summary === 'N/A') return;
      const sign = row.type === 'Refund' ? -1 : 1;
      row.item_summary.split(',').forEach(part => {
        const m = part.trim().match(/^([A-Za-z0-9]+)\s+x(\d+\.?\d*)/i);
        if (m && itemIdSet.has(m[1])) {
          unitsSold[m[1]] = (unitsSold[m[1]] || 0) + sign * (parseFloat(m[2]) || 0);
        }
      });
    });

    const originalPrices = schedule.original_prices || {};
    const discountFn = schedule.discount_type === 'percent'
      ? (v) => v * (1 - schedule.discount_value / 100)
      : (v) => Math.max(0, v - schedule.discount_value);

    const itemReport = items.map(item => {
      const units = Math.max(0, unitsSold[item.id] || 0);
      const origPrice = parseFloat(originalPrices[item.id] ?? item.price) || 0;
      const salePrice = Math.round(discountFn(origPrice) * 100) / 100;
      return {
        id: item.id,
        name: (item.group_name ? item.group_name + ' — ' : '') + (item.variant_name || item.id),
        units_sold: units,
        orig_price: origPrice,
        sale_price: salePrice,
        revenue: Math.round(units * salePrice * 100) / 100,
        discount_given: Math.round(units * (origPrice - salePrice) * 100) / 100
      };
    }).sort((a, b) => b.units_sold - a.units_sold);

    const totals = itemReport.reduce((acc, r) => ({
      units:          acc.units + r.units_sold,
      revenue:        acc.revenue + r.revenue,
      discount_given: acc.discount_given + r.discount_given
    }), { units: 0, revenue: 0, discount_given: 0 });

    res.json({
      schedule: {
        id: schedule.id, name: schedule.name,
        start_date: schedule.start_date, end_date: schedule.end_date,
        indefinite: schedule.indefinite, status: schedule.status,
        discount_type: schedule.discount_type, discount_value: schedule.discount_value
      },
      date_range: { from: startIso, to: endIso },
      items: itemReport,
      totals: {
        units: totals.units,
        revenue: Math.round(totals.revenue * 100) / 100,
        discount_given: Math.round(totals.discount_given * 100) / 100
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.runCron = runCron;
