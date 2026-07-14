const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../lib/supabase');
const { isHim } = require('../lib/roles');

function adminOnly(req, res, next) {
  if (!isHim(req.user.role)) return res.status(403).json({ error: 'Admin only' });
  next();
}

// ─── List notifications ───────────────────────────────────────────────────────
// HIM+ see target_role='admin' notifications.
// Store users see target_store_id=their store notifications.
// All users see target_user_id=their own notifications (assigned tasks etc.)
router.get('/', auth, async (req, res) => {
  try {
    let results = [];

    // Fetch role/store-scoped notifications
    if (isHim(req.user.role)) {
      const { data } = await supabase
        .from('notifications')
        .select('*')
        .eq('target_role', 'admin')
        .order('created_at', { ascending: false })
        .limit(50);
      results = results.concat(data || []);
    } else if (req.user.store_id) {
      const { data } = await supabase
        .from('notifications')
        .select('*')
        .eq('target_store_id', req.user.store_id)
        .order('created_at', { ascending: false })
        .limit(50);
      results = results.concat(data || []);
    }

    // Fetch direct user notifications (assigned tasks, completions)
    const { data: userNotifs } = await supabase
      .from('notifications')
      .select('*')
      .eq('target_user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(30);
    results = results.concat(userNotifs || []);

    // Deduplicate by id, sort by created_at desc
    const seen = new Set();
    const deduped = results.filter(n => {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 60);

    const unreadCount = deduped.filter(n => !n.read).length;
    res.json({ notifications: deduped, unread_count: unreadCount });
  } catch (err) {
    console.error('List notifications error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Mark a single notification read ─────────────────────────────────────────
router.put('/:id/read', auth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Mark all notifications read ─────────────────────────────────────────────
router.put('/read-all', auth, async (req, res) => {
  try {
    // Mark direct user notifications read
    await supabase.from('notifications').update({ read: true })
      .eq('target_user_id', req.user.id).eq('read', false);

    // Mark role/store notifications read
    if (isHim(req.user.role)) {
      await supabase.from('notifications').update({ read: true })
        .eq('target_role', 'admin').eq('read', false);

    } else if (req.user.store_id) {
      await supabase.from('notifications').update({ read: true })
        .eq('target_store_id', req.user.store_id).eq('read', false);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Activity log (HIM+)
router.get('/activity-log', auth, adminOnly, async (req, res) => {
  try {
    const { store_id, limit } = req.query;

    let query = supabase
      .from('activity_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(Math.min(parseInt(limit) || 100, 500));

    if (store_id) query = query.eq('store_id', store_id);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ activity: data || [] });
  } catch (err) {
    console.error('Activity log error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
