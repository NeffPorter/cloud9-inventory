const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../lib/supabase');

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ─── List notifications (admin) ──────────────────────────────────────────────
router.get('/', auth, adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('target_role', 'admin')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    const unreadCount = (data || []).filter(n => !n.read).length;
    res.json({ notifications: data || [], unread_count: unreadCount });
  } catch (err) {
    console.error('List notifications error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Mark a single notification read ─────────────────────────────────────────
router.put('/:id/read', auth, adminOnly, async (req, res) => {
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
router.put('/read-all', auth, adminOnly, async (req, res) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('target_role', 'admin')
      .eq('read', false);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Activity log (admin) ─────────────────────────────────────────────────────
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
