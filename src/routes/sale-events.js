const express = require('express');
const router = express.Router();
const axios = require('axios');
const supabase = require('../lib/supabase');
const auth = require('../middleware/auth');
const { getValidApiToken } = require('../services/clover');
const { isHim, isOwnerLevel } = require('../lib/roles');
const { notify } = require('../services/notify');

const CLOVER_BASE = 'https://api.clover.com/v3/merchants/';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function cloverHeaders(token) {
  return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
}

function calcDiscountedPrice(originalPrice, discountType, discountValue) {
  let p = discountType === 'percent'
    ? originalPrice * (1 - discountValue / 100)
    : originalPrice - discountValue;
  return Math.max(0, Math.round(p * 100) / 100);
}

function formatDiscountLabel(discountType, discountValue) {
  return discountType === 'percent' ? `${discountValue}% OFF` : `$${discountValue} OFF`;
}

async function setCloverItem(merchantId, apiToken, cloverItemId, name, priceDollars) {
  const body = { price: Math.round(priceDollars * 100) };
  if (name) body.name = name;
  await axios.post(
    `${CLOVER_BASE}${merchantId}/items/${cloverItemId}`,
    body,
    { headers: cloverHeaders(apiToken) }
  );
}

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

function requireAdmin(req, res, next) {
  if (!req.user || !isHim(req.user.role)) return res.status(403).json({ error: 'Admin only' });
  next();
}

// placeholder so existing code that sets req.profile still works
function setProfile(req, res, next) {
  next();
}

// ── SALE EVENTS (admin) ──────────────────────────────────────────────────────

// GET /api/sale-events — list all events
router.get('/', auth, async (req, res) => {
  try {
    const { data: events, error } = await supabase
      .from('sale_events')
      .select('*')
      .order('start_date', { ascending: false });
    if (error) throw error;

    // For each event, get assigned stores + proposal counts
    const enriched = await Promise.all((events || []).map(async ev => {
      const { data: ses } = await supabase
        .from('sale_event_stores')
        .select('store_id, stores(id, name)')
        .eq('sale_event_id', ev.id);
      const { data: proposals } = await supabase
        .from('sale_proposals')
        .select('id, store_id, status')
        .eq('sale_event_id', ev.id);
      return { ...ev, assigned_stores: (ses || []).map(s => s.stores), proposals: proposals || [] };
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sale-events/:id — single event detail with proposals
router.get('/:id', auth, async (req, res) => {
  try {
    const { data: ev, error } = await supabase.from('sale_events').select('*').eq('id', req.params.id).single();
    if (error || !ev) return res.status(404).json({ error: 'Not found' });

    const { data: ses } = await supabase.from('sale_event_stores').select('store_id, stores(id, name)').eq('sale_event_id', ev.id);
    const { data: proposals } = await supabase.from('sale_proposals').select('*, stores(name)').eq('sale_event_id', ev.id);

    // For each proposal, get its items
    const proposalsWithItems = await Promise.all((proposals || []).map(async p => {
      const { data: items } = await supabase.from('sale_proposal_items').select('*').eq('proposal_id', p.id);
      return { ...p, items: items || [] };
    }));

    res.json({ event: ev, assigned_stores: (ses || []).map(s => s.stores), proposals: proposalsWithItems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sale-events — create sale event (admin only)
router.post('/', auth, requireAdmin, async (req, res) => {
  try {
    const { name, description, purpose, start_date, end_date, proposal_due_date, store_ids } = req.body;
    if (!name || !start_date || !end_date || !proposal_due_date) {
      return res.status(400).json({ error: 'name, start_date, end_date, proposal_due_date required' });
    }

    const { data: ev, error } = await supabase
      .from('sale_events')
      .insert({ name, description, purpose, start_date, end_date, proposal_due_date, created_by: req.user.id, status: 'draft' })
      .select().single();
    if (error) throw error;

    // Assign stores and create proposals + tasks
    if (store_ids?.length) {
      await assignStoresToEvent(ev, store_ids);
    }

    res.json({ success: true, event: ev });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sale-events/:id — update event
router.put('/:id', auth, requireAdmin, async (req, res) => {
  try {
    const { name, description, purpose, start_date, end_date, proposal_due_date, status } = req.body;
    const updates = { name, description, purpose, start_date, end_date, proposal_due_date, status, updated_at: new Date().toISOString() };
    Object.keys(updates).forEach(k => updates[k] === undefined && delete updates[k]);

    const { data, error } = await supabase.from('sale_events').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, event: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sale-events/:id — hard delete event + all related data
router.delete('/:id', auth, requireAdmin, async (req, res) => {
  try {
    const evId = req.params.id;
    // Get all proposals for this event so we can cascade-delete tasks
    const { data: proposals } = await supabase.from('sale_proposals').select('id').eq('sale_event_id', evId);
    const proposalIds = (proposals || []).map(p => p.id);

    if (proposalIds.length) {
      // Delete store tasks tied to these proposals
      await supabase.from('store_tasks').delete().in('reference_id', proposalIds).eq('task_type', 'sale_proposal');
      // Delete proposal items
      await supabase.from('sale_proposal_items').delete().in('proposal_id', proposalIds);
      // Delete proposals
      await supabase.from('sale_proposals').delete().eq('sale_event_id', evId);
    }

    // Delete store assignments
    await supabase.from('sale_event_stores').delete().eq('sale_event_id', evId);

    // Delete the event itself
    const { error } = await supabase.from('sale_events').delete().eq('id', evId);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sale-events/:id/stores — assign stores to event
router.post('/:id/stores', auth, requireAdmin, async (req, res) => {
  try {
    const { store_ids } = req.body;
    const { data: ev } = await supabase.from('sale_events').select('*').eq('id', req.params.id).single();
    if (!ev) return res.status(404).json({ error: 'Event not found' });

    await assignStoresToEvent(ev, store_ids);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sale-events/:id/stores/:storeId — unassign a store
router.delete('/:id/stores/:storeId', auth, requireAdmin, async (req, res) => {
  try {
    await supabase.from('sale_event_stores').delete().eq('sale_event_id', req.params.id).eq('store_id', req.params.storeId);
    // Cancel the task and proposal for this store
    const { data: proposal } = await supabase.from('sale_proposals').select('id').eq('sale_event_id', req.params.id).eq('store_id', req.params.storeId).single();
    if (proposal) {
      await supabase.from('store_tasks').update({ status: 'completed' }).eq('reference_id', proposal.id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PROPOSALS ────────────────────────────────────────────────────────────────

// GET /api/sale-events/proposals/store/:storeId — get all proposals for a store
router.get('/proposals/store/:storeId', auth, async (req, res) => {
  try {
    const { data: proposals, error } = await supabase
      .from('sale_proposals')
      .select('*, sale_events(id, name, start_date, end_date, proposal_due_date, description, purpose)')
      .eq('store_id', req.params.storeId)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const withItems = await Promise.all((proposals || []).map(async p => {
      const { data: items } = await supabase.from('sale_proposal_items').select('*').eq('proposal_id', p.id);
      return { ...p, items: items || [] };
    }));

    res.json(withItems);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sale-events/proposals/:proposalId — single proposal
router.get('/proposals/:proposalId', auth, async (req, res) => {
  try {
    const { data: proposal, error } = await supabase
      .from('sale_proposals')
      .select('*, sale_events(*), stores(name)')
      .eq('id', req.params.proposalId)
      .single();
    if (error || !proposal) return res.status(404).json({ error: 'Not found' });

    const { data: items } = await supabase.from('sale_proposal_items').select('*').eq('proposal_id', proposal.id);
    res.json({ ...proposal, items: items || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sale-events/proposals/:proposalId/items — replace all items in proposal
router.put('/proposals/:proposalId/items', auth, async (req, res) => {
  try {
    const { items, store_notes } = req.body;
    const { data: proposal } = await supabase.from('sale_proposals').select('*').eq('id', req.params.proposalId).single();
    if (!proposal) return res.status(404).json({ error: 'Not found' });
    if (proposal.status === 'approved') return res.status(400).json({ error: 'Approved proposals cannot be edited' });

    // Replace items
    await supabase.from('sale_proposal_items').delete().eq('proposal_id', req.params.proposalId);
    if (items?.length) {
      const rows = items.map(i => ({
        proposal_id: req.params.proposalId,
        inventory_item_id: i.inventory_item_id || null,
        clover_item_id: i.clover_item_id || null,
        item_name: i.item_name,
        sku: i.sku || null,
        discount_type: i.discount_type,
        discount_value: i.discount_value
      }));
      await supabase.from('sale_proposal_items').insert(rows);
    }

    const updates = { store_notes: store_notes || proposal.store_notes, updated_at: new Date().toISOString() };
    await supabase.from('sale_proposals').update(updates).eq('id', req.params.proposalId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sale-events/proposals/:proposalId/submit — store submits proposal
router.post('/proposals/:proposalId/submit', auth, async (req, res) => {
  try {
    const { data: proposal } = await supabase.from('sale_proposals').select('*, sale_events(proposal_due_date)').eq('id', req.params.proposalId).single();
    if (!proposal) return res.status(404).json({ error: 'Not found' });

    const { data: items } = await supabase.from('sale_proposal_items').select('id').eq('proposal_id', req.params.proposalId);
    if (!items?.length) return res.status(400).json({ error: 'Add at least one item before submitting' });

    await supabase.from('sale_proposals').update({
      status: 'submitted',
      submitted_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', req.params.proposalId);

    // Mark store task as completed
    await supabase.from('store_tasks').update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('reference_id', req.params.proposalId).eq('task_type', 'sale_proposal');

    // Notify all HIM/RM via in-app + email
    const { data: saleEvent } = await supabase.from('sale_events').select('name').eq('id', proposal.sale_event_id).single();
    const { data: store } = await supabase.from('stores').select('name').eq('id', proposal.store_id).single();
    await notify({
      type: 'proposal_submitted',
      title: '📋 Sale Proposal Needs Review',
      message: `${store?.name || 'A store'} submitted their proposal for "${saleEvent?.name || 'a sale event'}". Review and approve or send back for revision.`,
      link: `/sale-events`,
      target_role: 'admin'
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sale-events/proposals/:proposalId/approve — HIM approves
router.post('/proposals/:proposalId/approve', auth, requireAdmin, async (req, res) => {
  try {
    const { him_notes } = req.body;
    await supabase.from('sale_proposals').update({
      status: 'approved',
      him_notes: him_notes || null,
      reviewed_at: new Date().toISOString(),
      reviewed_by: req.user.id,
      updated_at: new Date().toISOString()
    }).eq('id', req.params.proposalId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sale-events/proposals/:proposalId/reject — HIM sends back for revision
router.post('/proposals/:proposalId/reject', auth, requireAdmin, async (req, res) => {
  try {
    const { him_notes } = req.body;

    const { data: proposal } = await supabase.from('sale_proposals')
      .select('store_id, sale_event_id').eq('id', req.params.proposalId).single();

    await supabase.from('sale_proposals').update({
      status: 'rejected',
      him_notes: him_notes || null,
      reviewed_at: new Date().toISOString(),
      reviewed_by: req.user.id,
      updated_at: new Date().toISOString()
    }).eq('id', req.params.proposalId);

    // Re-open task with updated title/description so IM sees it needs revision
    const { data: saleEvent } = await supabase.from('sale_events')
      .select('name').eq('id', proposal.sale_event_id).single();
    const eventName = saleEvent?.name || 'Sale Event';
    const taskTitle = `⚠️ Sale Proposal Needs Revision: ${eventName}`;
    const taskDesc = him_notes
      ? `Changes requested: ${him_notes}`
      : `Your proposal for "${eventName}" was sent back for revision. Open it to see the feedback.`;

    await supabase.from('store_tasks').update({
      status: 'pending',
      title: taskTitle,
      description: taskDesc,
      updated_at: new Date().toISOString()
    }).eq('reference_id', req.params.proposalId).eq('task_type', 'sale_proposal');

    // Notify the store's GM/IM via in-app + email
    if (proposal?.store_id) {
      await notify({
        type: 'proposal_revision_requested',
        title: '⚠️ Sale Proposal Needs Revision',
        message: him_notes
          ? `Your proposal for "${eventName}" needs changes: ${him_notes}`
          : `Your proposal for "${eventName}" was sent back for revision. Check your to-do list.`,
        link: `/sale-proposal?id=${req.params.proposalId}`,
        target_store_id: proposal.store_id
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CRON: Apply / Remove discounts ─────────────────────────────────────────

async function runSaleEventCron() {
  const today = new Date().toISOString().split('T')[0];

  // Apply discounts for events starting today (approved proposals not yet applied)
  const { data: toApply } = await supabase
    .from('sale_proposals')
    .select('*, sale_events(start_date, end_date, name), stores(merchant_id, api_token)')
    .eq('status', 'approved')
    .eq('clover_applied', false);

  for (const proposal of (toApply || [])) {
    const ev = proposal.sale_events;
    if (!ev || ev.start_date > today) continue; // not yet
    if (ev.end_date < today) continue; // already expired

    const store = proposal.stores;
    if (!store?.merchant_id || !store?.api_token) continue;

    await applyProposalToClover(proposal, store);
  }

  // Remove discounts for events that ended yesterday
  const { data: toRemove } = await supabase
    .from('sale_proposals')
    .select('*, sale_events(end_date, name), stores(merchant_id, api_token)')
    .eq('status', 'approved')
    .eq('clover_applied', true);

  for (const proposal of (toRemove || [])) {
    const ev = proposal.sale_events;
    if (!ev || ev.end_date >= today) continue; // still active
    const store = proposal.stores;
    if (!store?.merchant_id || !store?.api_token) continue;
    await removeProposalFromClover(proposal, store);
  }
}

async function applyProposalToClover(proposal, store) {
  try {
    const apiToken = await getValidApiToken(store);
    const { data: propItems } = await supabase.from('sale_proposal_items').select('*').eq('proposal_id', proposal.id);
    if (!propItems?.length) return;

    const { data: ev } = await supabase.from('sale_events').select('name').eq('id', proposal.sale_event_id).single();
    const saleName = ev?.name || 'Sale';

    // Snapshot original prices before touching anything (same pattern as discount_schedules)
    const originalPrices = { ...(proposal.original_prices || {}) };
    let snapshotChanged = false;

    // Collect all inventory items we'll need
    const itemIds = propItems.map(p => p.inventory_item_id).filter(Boolean);
    const { data: invItems } = await supabase.from('inventory_items')
      .select('id, price, variant_name, group_name')
      .in('id', itemIds);
    const invMap = Object.fromEntries((invItems || []).map(i => [i.id, i]));

    for (const propItem of propItems) {
      const itemId = propItem.inventory_item_id;
      if (!itemId || !invMap[itemId]?.price) continue;
      if (originalPrices[itemId] === undefined) {
        originalPrices[itemId] = parseFloat(invMap[itemId].price);
        snapshotChanged = true;
      }
    }
    if (snapshotChanged) {
      await supabase.from('sale_proposals').update({ original_prices: originalPrices }).eq('id', proposal.id);
    }

    // Rename item groups (same approach as discount_schedules)
    const groupRenames = {};
    const uniqueGroups = [...new Set(
      propItems.map(p => invMap[p.inventory_item_id]?.group_name).filter(Boolean)
    )];
    for (const groupName of uniqueGroups) {
      const sampleItem = propItems.find(p => invMap[p.inventory_item_id]?.group_name === groupName);
      if (!sampleItem) continue;
      await sleep(300);
      let cloverGroupId = null;
      try {
        cloverGroupId = await getCloverItemGroupId(store.merchant_id, apiToken, sampleItem.inventory_item_id);
      } catch (err) {
        if (err.response?.status === 429) {
          await sleep(2500);
          try { cloverGroupId = await getCloverItemGroupId(store.merchant_id, apiToken, sampleItem.inventory_item_id); } catch {}
        }
      }
      if (cloverGroupId) {
        groupRenames[groupName] = { cloverGroupId, originalName: groupName };
        const newGroupName = `${saleName} - ${groupName}`.slice(0, 127);
        try {
          await renameCloverItemGroup(store.merchant_id, apiToken, cloverGroupId, newGroupName);
          await sleep(300);
        } catch (err) {
          console.error(`Failed to rename group "${groupName}" for sale event:`, err.message);
        }
      }
    }

    // Update item prices (and names for ungrouped items)
    const applied = [];
    for (const propItem of propItems) {
      const itemId = propItem.inventory_item_id;
      if (!itemId) continue;
      const invItem = invMap[itemId];
      if (!invItem?.price) continue;

      const basePrice = originalPrices[itemId] ?? parseFloat(invItem.price);
      const discountedPrice = calcDiscountedPrice(basePrice, propItem.discount_type, propItem.discount_value);
      const discountLabel = formatDiscountLabel(propItem.discount_type, propItem.discount_value);
      const displayName = invItem.variant_name || propItem.item_name || itemId;
      const newName = invItem.group_name ? null : `${saleName} ${discountLabel} - ${displayName}`;

      try {
        await setCloverItem(store.merchant_id, apiToken, itemId, newName, discountedPrice);
        applied.push(itemId);
        await sleep(300);
      } catch (err) {
        if (err.response?.status === 429) {
          await sleep(2000);
          try {
            await setCloverItem(store.merchant_id, apiToken, itemId, newName, discountedPrice);
            applied.push(itemId);
            await sleep(300);
          } catch (retryErr) {
            console.error(`Failed after retry for item ${itemId}:`, retryErr.message);
          }
        } else {
          console.error(`Failed to apply sale to item ${itemId}:`, err.message);
        }
      }
    }

    await supabase.from('sale_proposals').update({
      clover_applied: true,
      applied_item_ids: applied,
      group_renames: groupRenames,
      updated_at: new Date().toISOString()
    }).eq('id', proposal.id);

    console.log(`Applied sale "${saleName}" — ${applied.length} items + ${uniqueGroups.length} groups updated on Clover for store ${store.merchant_id}`);
  } catch (err) {
    console.error(`applyProposalToClover error for proposal ${proposal.id}:`, err.message);
  }
}

async function removeProposalFromClover(proposal, store) {
  try {
    const apiToken = await getValidApiToken(store);
    const appliedIds = proposal.applied_item_ids || [];
    if (!appliedIds.length) return;

    const snapshotPrices = proposal.original_prices || {};
    const groupRenames = proposal.group_renames || {};

    for (const [originalName, groupInfo] of Object.entries(groupRenames)) {
      if (!groupInfo.cloverGroupId) continue;
      try {
        await renameCloverItemGroup(store.merchant_id, apiToken, groupInfo.cloverGroupId, originalName);
        await sleep(300);
      } catch (err) {
        console.error(`Failed to restore group "${originalName}":`, err.message);
      }
    }

    const { data: items } = await supabase.from('inventory_items')
      .select('id, price, variant_name, group_name')
      .in('id', appliedIds)
      .eq('store_id', proposal.store_id);

    for (const item of items || []) {
      const restorePrice = snapshotPrices[item.id] != null
        ? parseFloat(snapshotPrices[item.id])
        : parseFloat(item.price);
      if (!restorePrice) continue;
      const restoreName = item.group_name ? null : (item.variant_name || null);
      try {
        await setCloverItem(store.merchant_id, apiToken, item.id, restoreName, restorePrice);
        await sleep(300);
      } catch (err) {
        if (err.response?.status === 429) {
          await sleep(2000);
          try {
            await setCloverItem(store.merchant_id, apiToken, item.id, restoreName, restorePrice);
            await sleep(300);
          } catch (retryErr) {
            console.error(`Failed after retry restoring item ${item.id}:`, retryErr.message);
          }
        } else {
          console.error(`Failed to restore item ${item.id}:`, err.message);
        }
      }
    }

    await supabase.from('sale_proposals').update({
      clover_applied: false,
      applied_item_ids: [],
      group_renames: {},
      updated_at: new Date().toISOString()
    }).eq('id', proposal.id);

    console.log(`Restored prices + group names on Clover for proposal ${proposal.id}`);
  } catch (err) {
    console.error(`removeProposalFromClover error:`, err.message);
  }
}

async function assignStoresToEvent(ev, storeIds) {
  for (const storeId of storeIds) {
    await supabase.from('sale_event_stores').upsert({ sale_event_id: ev.id, store_id: storeId }, { onConflict: 'sale_event_id,store_id' });
    const { data: existing } = await supabase.from('sale_proposals').select('id').eq('sale_event_id', ev.id).eq('store_id', storeId).single();
    let proposalId = existing?.id;
    if (!proposalId) {
      const { data: proposal } = await supabase.from('sale_proposals').insert({ sale_event_id: ev.id, store_id: storeId, status: 'pending' }).select().single();
      proposalId = proposal?.id;
    }
    if (proposalId) {
      const { data: existingTask } = await supabase.from('store_tasks').select('id').eq('reference_id', proposalId).eq('task_type', 'sale_proposal').single();
      if (!existingTask) {
        await supabase.from('store_tasks').insert({
          store_id: storeId,
          task_type: 'sale_proposal',
          reference_id: proposalId,
          title: `Sale Proposal: ${ev.name}`,
          description: ev.description || `Complete your discount proposal for the "${ev.name}" sale.`,
          due_date: ev.proposal_due_date,
          status: 'pending'
        });
      }
    }
  }
}

module.exports = router;
module.exports.runSaleEventCron = runSaleEventCron;
