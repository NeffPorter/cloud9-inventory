const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../lib/supabase');
const { isHim } = require('../lib/roles');

// Which roles can see everything vs just their store
function isElevated(role) {
  return isHim(role) || role === 'owner' || role === 'marketing';
}

// GET /api/calendar/events?start=YYYY-MM-DD&end=YYYY-MM-DD&store_id=
// Returns merged events from: calendar_events, sale_events, store_tasks, assigned_tasks, discount_schedules
router.get('/events', auth, async (req, res) => {
  try {
    const { start, end, store_id } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end dates required' });

    const role = req.user.role;
    const userId = req.user.id;
    const elevated = isElevated(role);
    const userStoreId = req.user.store_id;
    const filterStore = elevated ? (store_id || null) : userStoreId;

    const events = [];

    // ── 1. Custom calendar_events ──────────────────────────────────────────
    let ceQuery = supabase.from('calendar_events')
      .select('*, users!calendar_events_created_by_fkey(name)')
      .gte('start_date', start)
      .lte('start_date', end)
      .order('start_date');

    if (filterStore) ceQuery = ceQuery.or(`store_id.eq.${filterStore},store_id.is.null`);

    const { data: customEvents } = await ceQuery;
    (customEvents || []).forEach(e => {
      // Expand recurring events within the range
      const expanded = expandRecurring(e, start, end);
      expanded.forEach(date => events.push({
        id: e.id,
        source: 'custom',
        title: e.title,
        description: e.description,
        type: e.event_type,
        date,
        end_date: e.end_date,
        color: e.color || '#2563eb',
        store_id: e.store_id,
        recurring: e.recurring,
        all_day: e.all_day,
        created_by_name: e.users?.name || null,
        editable: elevated || e.created_by === userId
      }));
    });

    // ── 2. Sale events ─────────────────────────────────────────────────────
    let seQuery = supabase.from('sale_events')
      .select('id, name, start_date, end_date, proposal_due_date, status')
      .or(`start_date.gte.${start},end_date.gte.${start},proposal_due_date.gte.${start}`)
      .lte('start_date', end);

    // If filtered to a store, only show events assigned to that store
    if (filterStore) {
      const { data: storeEvents } = await supabase
        .from('sale_event_stores')
        .select('sale_event_id')
        .eq('store_id', filterStore);
      const ids = (storeEvents || []).map(s => s.sale_event_id);
      if (!ids.length) {
        // no events for this store — skip
      } else {
        seQuery = seQuery.in('id', ids);
        const { data: saleEvents } = await seQuery;
        (saleEvents || []).forEach(e => {
          // Sale event span
          if (e.start_date >= start && e.start_date <= end) {
            events.push({ id: `se-${e.id}`, source: 'sale_event', title: `🎯 ${e.name}`, type: 'sale_event', date: e.start_date, end_date: e.end_date, color: '#f59e0b', editable: false });
          }
          // Proposal due date
          if (e.proposal_due_date && e.proposal_due_date >= start && e.proposal_due_date <= end) {
            events.push({ id: `se-due-${e.id}`, source: 'sale_event', title: `📋 Proposal Due: ${e.name}`, type: 'proposal_due', date: e.proposal_due_date, color: '#ef4444', editable: false });
          }
        });
      }
    } else {
      const { data: saleEvents } = await seQuery;
      (saleEvents || []).forEach(e => {
        if (e.start_date >= start && e.start_date <= end) {
          events.push({ id: `se-${e.id}`, source: 'sale_event', title: `🎯 ${e.name}`, type: 'sale_event', date: e.start_date, end_date: e.end_date, color: '#f59e0b', editable: false });
        }
        if (e.proposal_due_date && e.proposal_due_date >= start && e.proposal_due_date <= end) {
          events.push({ id: `se-due-${e.id}`, source: 'sale_event', title: `📋 Proposal Due: ${e.name}`, type: 'proposal_due', date: e.proposal_due_date, color: '#ef4444', editable: false });
        }
      });
    }

    // ── 3. Discount schedules ──────────────────────────────────────────────
    let dsQuery = supabase.from('discount_schedules')
      .select('id, name, start_date, end_date, store_id, status')
      .gte('start_date', start)
      .lte('start_date', end)
      .neq('status', 'cancelled');
    if (filterStore) dsQuery = dsQuery.eq('store_id', filterStore);

    const { data: discounts } = await dsQuery;
    (discounts || []).forEach(d => {
      events.push({ id: `ds-${d.id}`, source: 'discount', title: `🏷️ ${d.name}`, type: 'discount', date: d.start_date, end_date: d.end_date, color: '#8b5cf6', store_id: d.store_id, editable: false });
    });

    // ── 4. Store tasks ─────────────────────────────────────────────────────
    let stQuery = supabase.from('store_tasks')
      .select('id, title, due_date, store_id, status, task_type')
      .gte('due_date', start)
      .lte('due_date', end)
      .not('due_date', 'is', null)
      .neq('status', 'done');
    if (filterStore) stQuery = stQuery.eq('store_id', filterStore);

    const { data: storeTasks } = await stQuery;
    (storeTasks || []).forEach(t => {
      events.push({ id: `st-${t.id}`, source: 'store_task', title: `✅ ${t.title}`, type: 'task', date: t.due_date, color: '#10b981', store_id: t.store_id, editable: false });
    });

    // ── 5. Assigned tasks ──────────────────────────────────────────────────
    let atQuery = supabase.from('assigned_tasks')
      .select('id, title, due_date, assigned_to, store_id, status, users!assigned_tasks_assigned_to_fkey(name)')
      .gte('due_date', start)
      .lte('due_date', end)
      .not('due_date', 'is', null)
      .neq('status', 'completed');

    // Users only see their own assigned tasks unless elevated
    if (!elevated) atQuery = atQuery.eq('assigned_to', userId);
    else if (filterStore) atQuery = atQuery.eq('store_id', filterStore);

    const { data: assignedTasks } = await atQuery;
    (assignedTasks || []).forEach(t => {
      events.push({ id: `at-${t.id}`, source: 'assigned_task', title: `📋 ${t.title}`, type: 'task', date: t.due_date, color: '#06b6d4', store_id: t.store_id, assigned_to_name: t.users?.name || null, editable: false });
    });

    res.json({ events });
  } catch (err) {
    console.error('[Calendar] GET events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calendar/events — create custom event
router.post('/events', auth, async (req, res) => {
  try {
    const { title, description, event_type, start_date, end_date, all_day, store_id, recurring, recurring_until, color } = req.body;
    if (!title || !start_date) return res.status(400).json({ error: 'title and start_date required' });

    const role = req.user.role;
    // Only elevated roles can create store-wide events
    const effectiveStoreId = (isElevated(role) && store_id) ? store_id : (store_id || req.user.store_id || null);

    const { data, error } = await supabase.from('calendar_events').insert({
      title,
      description: description || null,
      event_type: event_type || 'event',
      start_date,
      end_date: end_date || null,
      all_day: all_day !== false,
      store_id: effectiveStoreId,
      created_by: req.user.id,
      recurring: recurring || 'none',
      recurring_until: recurring_until || null,
      color: color || '#2563eb'
    }).select().single();

    if (error) throw error;
    res.json({ event: data });
  } catch (err) {
    console.error('[Calendar] POST event error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/calendar/events/:id
router.put('/events/:id', auth, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('calendar_events').select('created_by').eq('id', req.params.id).single();
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (!isElevated(req.user.role) && existing.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { title, description, event_type, start_date, end_date, all_day, store_id, recurring, recurring_until, color } = req.body;
    const { data, error } = await supabase.from('calendar_events').update({
      title, description, event_type, start_date, end_date, all_day,
      store_id, recurring, recurring_until, color,
      updated_at: new Date().toISOString()
    }).eq('id', req.params.id).select().single();

    if (error) throw error;
    res.json({ event: data });
  } catch (err) {
    console.error('[Calendar] PUT event error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/calendar/events/:id
router.delete('/events/:id', auth, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('calendar_events').select('created_by').eq('id', req.params.id).single();
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (!isElevated(req.user.role) && existing.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    await supabase.from('calendar_events').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Calendar] DELETE event error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: expand a recurring event into all occurrence dates within [start, end]
function expandRecurring(event, rangeStart, rangeEnd) {
  const dates = [];
  const base = event.start_date;

  if (!event.recurring || event.recurring === 'none') {
    if (base >= rangeStart && base <= rangeEnd) dates.push(base);
    return dates;
  }

  const until = event.recurring_until || rangeEnd;
  const effectiveEnd = until < rangeEnd ? until : rangeEnd;

  let current = new Date(base + 'T00:00:00');
  const end = new Date(effectiveEnd + 'T00:00:00');
  const start = new Date(rangeStart + 'T00:00:00');

  let iterations = 0;
  while (current <= end && iterations < 500) {
    iterations++;
    const dateStr = current.toISOString().split('T')[0];
    if (current >= start) dates.push(dateStr);

    if (event.recurring === 'daily') current.setDate(current.getDate() + 1);
    else if (event.recurring === 'weekly') current.setDate(current.getDate() + 7);
    else if (event.recurring === 'monthly') current.setMonth(current.getMonth() + 1);
    else if (event.recurring === 'yearly') current.setFullYear(current.getFullYear() + 1);
    else break;
  }

  return dates;
}

module.exports = router;
