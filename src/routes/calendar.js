const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../lib/supabase');
const { isHim } = require('../lib/roles');

// Elevated = can see/assign all users' events
function isElevated(role) {
  return isHim(role) || role === 'owner' || role === 'marketing';
}

// Fixed colors per event type (used server-side and matches frontend)
const TYPE_COLORS = {
  event:        '#2563eb',
  meeting:      '#8b5cf6',
  reminder:     '#f59e0b',
  deadline:     '#ef4444',
  other:        '#6b7280',
  // auto-populated from other tables:
  sale_event:   '#f97316',
  proposal_due: '#ef4444',
  task:         '#10b981',
};

// GET /api/calendar/users — list of users for assignment (elevated roles only)
router.get('/users', auth, async (req, res) => {
  try {
    if (!isElevated(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const { data, error } = await supabase
      .from('users')
      .select('id, name, email, role, store_id')
      .order('name');
    if (error) throw error;
    res.json({ users: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calendar/events?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get('/events', auth, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const role     = req.user.role;
    const userId   = req.user.id;
    const elevated = isElevated(role);
    const storeId  = req.user.store_id;

    const events = [];

    // ── 1. Custom calendar_events ────────────────────────────────────────
    // Fetch events that OVERLAP the range: start_date <= rangeEnd AND end_date >= rangeStart
    let ceQuery = supabase
      .from('calendar_events')
      .select('*, users!calendar_events_created_by_fkey(id, name), calendar_event_users(user_id, users(id, name))')
      .lte('start_date', end)
      .order('start_date');

    const { data: customRaw } = await ceQuery;
    let customEvents = (customRaw || []).filter(e => {
      const effectiveEnd = e.end_date || e.start_date;
      return effectiveEnd >= start;
    });

    // Access filter for non-elevated users
    if (!elevated) {
      customEvents = customEvents.filter(e => {
        if (e.created_by === userId) return true;
        const assignedIds = (e.calendar_event_users || []).map(u => u.user_id);
        return assignedIds.includes(userId);
      });
    }

    customEvents.forEach(e => {
      const assignedUsers = (e.calendar_event_users || []).map(u => ({
        id: u.user_id, name: u.users?.name || u.user_id
      }));
      events.push({
        id: e.id,
        source: 'custom',
        title: e.title,
        description: e.description,
        type: e.event_type,
        date: e.start_date,
        end_date: e.end_date,
        color: TYPE_COLORS[e.event_type] || TYPE_COLORS.event,
        recurring: e.recurring,
        recurring_until: e.recurring_until,
        all_day: e.all_day,
        created_by: e.created_by,
        created_by_name: e.users?.name || null,
        assigned_users: assignedUsers,
        editable: elevated || e.created_by === userId
      });
    });

    // Auto-populated events only shown to elevated OR scoped to user's store
    const showAuto = elevated || !!storeId;

    if (showAuto) {
      // ── 2. Sale events ─────────────────────────────────────────────────
      let seQuery = supabase.from('sale_events')
        .select('id, name, start_date, end_date, proposal_due_date, status')
        .lte('start_date', end);

      if (!elevated && storeId) {
        const { data: ses } = await supabase.from('sale_event_stores').select('sale_event_id').eq('store_id', storeId);
        const ids = (ses || []).map(s => s.sale_event_id);
        if (ids.length) seQuery = seQuery.in('id', ids);
        else seQuery = seQuery.eq('id', 'none'); // no results
      }

      const { data: saleEvents } = await seQuery;
      (saleEvents || []).forEach(e => {
        if (e.start_date >= start || (e.end_date && e.end_date >= start)) {
          events.push({ id: `se-${e.id}`, source: 'sale_event', title: `🎯 ${e.name}`, type: 'sale_event', date: e.start_date, end_date: e.end_date, color: TYPE_COLORS.sale_event, editable: false });
        }
        if (e.proposal_due_date && e.proposal_due_date >= start && e.proposal_due_date <= end) {
          events.push({ id: `se-due-${e.id}`, source: 'sale_event', title: `📋 ${e.name} — Proposal Due`, type: 'deadline', date: e.proposal_due_date, color: TYPE_COLORS.deadline, editable: false });
        }
      });

      // ── 4. Store tasks ────────────────────────────────────────────────
      let stQuery = supabase.from('store_tasks')
        .select('id, title, due_date, store_id')
        .gte('due_date', start).lte('due_date', end).not('due_date', 'is', null);
      if (!elevated && storeId) stQuery = stQuery.eq('store_id', storeId);

      const { data: storeTasks } = await stQuery;
      (storeTasks || []).forEach(t => {
        events.push({ id: `st-${t.id}`, source: 'store_task', title: `✅ ${t.title}`, type: 'task', date: t.due_date, color: TYPE_COLORS.task, editable: false });
      });

      // ── 5. Assigned tasks ─────────────────────────────────────────────
      let atQuery = supabase.from('assigned_tasks')
        .select('id, title, due_date, assigned_to, store_id, users!assigned_tasks_assigned_to_fkey(name)')
        .gte('due_date', start).lte('due_date', end).not('due_date', 'is', null).neq('status', 'completed');
      if (!elevated) atQuery = atQuery.eq('assigned_to', userId);

      const { data: assignedTasks } = await atQuery;
      (assignedTasks || []).forEach(t => {
        events.push({ id: `at-${t.id}`, source: 'assigned_task', title: `📋 ${t.title}`, type: 'task', date: t.due_date, color: TYPE_COLORS.task, assigned_to_name: t.users?.name || null, editable: false });
      });
    }

    // Expand recurring custom events
    const expandedEvents = [];
    events.forEach(e => {
      if (e.source !== 'custom' || !e.recurring || e.recurring === 'none') {
        expandedEvents.push(e);
        return;
      }
      const occurrences = expandRecurring(e, start, end);
      // Always clear end_date on expanded occurrences — prevents i===0 from inheriting
      // a stale end_date that would cause the event to appear on every day in between.
      occurrences.forEach((date, i) => {
        expandedEvents.push({ ...e, id: i === 0 ? e.id : `${e.id}_${i}`, date, end_date: null });
      });
    });

    res.json({ events: expandedEvents });
  } catch (err) {
    console.error('[Calendar] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calendar/events
router.post('/events', auth, async (req, res) => {
  try {
    const { title, description, event_type, start_date, end_date, all_day, assigned_user_ids, recurring, recurring_until } = req.body;
    if (!title || !start_date) return res.status(400).json({ error: 'title and start_date required' });

    const color = TYPE_COLORS[event_type] || TYPE_COLORS.event;

    const { data: ev, error } = await supabase.from('calendar_events').insert({
      title,
      description: description || null,
      event_type: event_type || 'event',
      start_date,
      end_date: end_date || null,
      all_day: all_day !== false,
      created_by: req.user.id,
      recurring: recurring || 'none',
      recurring_until: recurring_until || null,
      color,
      store_id: null
    }).select().single();

    if (error) throw error;

    // Assign users — always include creator, plus any selected users
    const userIds = new Set([req.user.id, ...((assigned_user_ids || []).filter(Boolean))]);
    // Non-elevated users can only assign to themselves
    if (!isElevated(req.user.role)) userIds.clear(), userIds.add(req.user.id);

    if (userIds.size) {
      await supabase.from('calendar_event_users').insert(
        [...userIds].map(uid => ({ event_id: ev.id, user_id: uid }))
      );
    }

    res.json({ event: ev });
  } catch (err) {
    console.error('[Calendar] POST error:', err.message);
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

    const { title, description, event_type, start_date, end_date, all_day, assigned_user_ids, recurring, recurring_until } = req.body;
    const color = TYPE_COLORS[event_type] || TYPE_COLORS.event;

    const { data, error } = await supabase.from('calendar_events').update({
      title, description, event_type, start_date, end_date, all_day, recurring, recurring_until, color,
      updated_at: new Date().toISOString()
    }).eq('id', req.params.id).select().single();

    if (error) throw error;

    // Replace user assignments
    if (assigned_user_ids !== undefined) {
      await supabase.from('calendar_event_users').delete().eq('event_id', req.params.id);
      const userIds = new Set([existing.created_by, ...((assigned_user_ids || []).filter(Boolean))]);
      if (!isElevated(req.user.role)) { userIds.clear(); userIds.add(req.user.id); }
      if (userIds.size) {
        await supabase.from('calendar_event_users').insert(
          [...userIds].map(uid => ({ event_id: req.params.id, user_id: uid }))
        );
      }
    }

    res.json({ event: data });
  } catch (err) {
    console.error('[Calendar] PUT error:', err.message);
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
    console.error('[Calendar] DELETE error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function expandRecurring(event, rangeStart, rangeEnd) {
  const dates = [];
  const until = event.recurring_until || rangeEnd;
  const effectiveEnd = until < rangeEnd ? until : rangeEnd;
  let current = new Date(event.date + 'T00:00:00');
  const end = new Date(effectiveEnd + 'T00:00:00');
  const start = new Date(rangeStart + 'T00:00:00');
  let i = 0;
  while (current <= end && i < 500) {
    i++;
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
