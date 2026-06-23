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
router.get('/', auth, async (req, res) => {
  try {
    let query = supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (isHim(req.user.role)) {
      query = query.eq('target_role', 'admin');
    } else if (req.user.store_id) {
      query = query.eq('target_store_id', req.user.store_id);
    } else {
      return res.json({ notifications: [], unread_count: 0 });
    }

    const { data, error } = await query;
    if (error) throw error;

    const unreadCount = (data || []).filter(n => !n.read).length;
    res.json({ notifications: data || [], unread_count: unreadCount });
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
    let query = supabase.from('notifications').update({ read: true }).eq('read', false);
    if (isHim(req.user.role)) {
      query = query.eq('target_role', 'admin');
    } else if (req.user.store_id) {
      query = query.eq('target_store_id', req.user.store_id);
    }
    const { error } = await query;

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Activity log (HIM+) ──────────────────────────────────────────────────────
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
