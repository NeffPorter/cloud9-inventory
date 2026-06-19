const express = require('express');
const router = express.Router();
const axios = require('axios');
const supabase = require('../lib/supabase');
const auth = require('../middleware/auth');

const CLOVER_BASE = 'https://api.clover.com/v3/merchants/';

function cloverHeaders(token) {
  return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
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

// POST /api/sale-events/proposals/:proposalId/reject — HIM rejects (sends back for revision)
router.post('/proposals/:proposalId/reject', auth, requireAdmin, async (req, res) => {
  try {
    const { him_notes } = req.body;
    await supabase.from('sale_proposals').update({
      status: 'rejected',
      him_notes: him_notes || null,
      reviewed_at: new Date().toISOString(),
      reviewed_by: req.user.id,
      updated_at: new Date().toISOString()
    }).eq('id', req.params.proposalId);

    // Re-open store task
    await supabase.from('store_tasks').update({ status: 'pending', updated_at: new Date().toISOString() })
      .eq('reference_id', req.params.proposalId).eq('task_type', 'sale_proposal');

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
    const { data: items } = await supabase.from('sale_proposal_items').select('*').eq('proposal_id', proposal.id);
    if (!items?.length) return;

    const { data: ev } = await supabase.from('sale_events').select('name').eq('id', proposal.sale_event_id).single();
    const discountName = ev?.name || 'Sale';

    // Group items by discount type + value to minimise Clover discount objects
    const groups = {};
    for (const item of items) {
      if (!item.clover_item_id) continue;
      const key = `${item.discount_type}|${item.discount_value}`;
      if (!groups[key]) groups[key] = { discount_type: item.discount_type, discount_value: item.discount_value, clover_item_ids: [] };
      groups[key].clover_item_ids.push(item.clover_item_id);
    }

    const appliedDiscountIds = [];
    for (const g of Object.values(groups)) {
      const payload = { name: discountName };
      if (g.discount_type === 'percent') payload.percentage = Math.round(g.discount_value * 10);
      else payload.amount = Math.round(g.discount_value * 100);

      const createRes = await axios.post(
        `${CLOVER_BASE}${store.merchant_id}/discounts`, payload,
        { headers: cloverHeaders(store.api_token) }
      );
      const discountId = createRes.data.id;
      appliedDiscountIds.push(discountId);

      for (const itemId of g.clover_item_ids) {
        try {
          await axios.post(
            `${CLOVER_BASE}${store.merchant_id}/items/${itemId}/discounts`,
            { id: discountId },
            { headers: cloverHeaders(store.api_token) }
          );
        } catch (e) {
          console.error(`Failed to attach discount to item ${itemId}:`, e.message);
        }
      }
    }

    await supabase.from('sale_proposals').update({
      clover_applied: true,
      him_notes: (proposal.him_notes ? proposal.him_notes + '\n' : '') + `Applied to Clover: ${new Date().toISOString()} | Discount IDs: ${appliedDiscountIds.join(', ')}`,
      updated_at: new Date().toISOString()
    }).eq('id', proposal.id);

    console.log(`Applied sale "${discountName}" to Clover for store ${store.merchant_id}`);
  } catch (err) {
    console.error(`applyProposalToClover error for proposal ${proposal.id}:`, err.message);
  }
}

async function removeProposalFromClover(proposal, store) {
  try {
    // Extract discount IDs from him_notes (stored on apply)
    const match = (proposal.him_notes || '').match(/Discount IDs: ([\w,\s]+)/);
    if (!match) return;
    const discountIds = match[1].split(',').map(s => s.trim()).filter(Boolean);

    for (const discountId of discountIds) {
      // Get items attached to this discount and remove
      try {
        const itemsRes = await axios.get(
          `${CLOVER_BASE}${store.merchant_id}/discounts/${discountId}/items`,
          { headers: cloverHeaders(store.api_token) }
        );
        const cloverItems = itemsRes.data?.elements || [];
        for (const ci of cloverItems) {
          try {
            await axios.delete(
              `${CLOVER_BASE}${store.merchant_id}/items/${ci.id}/discounts/${discountId}`,
              { headers: cloverHeaders(store.api_token) }
            );
          } catch (e) {}
        }
        await axios.delete(`${CLOVER_BASE}${store.merchant_id}/discounts/${discountId}`, { headers: cloverHeaders(store.api_token) });
      } catch (e) {
        console.error(`Failed to remove discount ${discountId}:`, e.message);
      }
    }

    await supabase.from('sale_proposals').update({ clover_applied: false, updated_at: new Date().toISOString() }).eq('id', proposal.id);
    console.log(`Removed sale discounts from Clover for proposal ${proposal.id}`);
  } catch (err) {
    console.error(`removeProposalFromClover error:`, err.message);
  }
}

// ── HELPERS ─────────────────────────────────────────────────────────────────

async function assignStoresToEvent(ev, storeIds) {
  for (const storeId of storeIds) {
    // Upsert assignment
    await supabase.from('sale_event_stores').upsert({ sale_event_id: ev.id, store_id: storeId }, { onConflict: 'sale_event_id,store_id' });

    // Create proposal if not exists
    const { data: existing } = await supabase.from('sale_proposals').select('id').eq('sale_event_id', ev.id).eq('store_id', storeId).single();
    let proposalId = existing?.id;
    if (!proposalId) {
      const { data: proposal } = await supabase.from('sale_proposals').insert({ sale_event_id: ev.id, store_id: storeId, status: 'pending' }).select().single();
      proposalId = proposal?.id;
    }

    if (proposalId) {
      // Create to-do task if not exists
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
