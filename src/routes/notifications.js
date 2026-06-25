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


// ── POST /api/notifications/send-demo-emails — fire example emails (admin only, temp)
router.post('/send-demo-emails', auth, adminOnly, async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'to email required' });

    const { sendNotificationEmail } = require('../services/email');

    const emails = [
      {
        title: '⚠️ Low Stock Alert — Test Merchant',
        message: 'GeekBar Pulse X (Strawberry Kiwi Ice) is running low at Test Merchant — only 2 units remaining. Suggested reorder qty: 12.',
        link: '/inventory'
      },
      {
        title: '💰 Budget Warning — 87% Used',
        message: 'Test Merchant 2 has used 87% of their weekly ordering budget ($801.40 of $922.62). Only $121.22 remaining for the week of 06/22 – 06/28.',
        link: '/budgets'
      },
      {
        title: '📦 Stocktake Complete — Test Merchant',
        message: 'Sarah M. completed a full stocktake at Test Merchant on 06/14/2026. 12 shortages detected across 487 items counted. Estimated shrinkage value: $312.85.',
        link: '/stocktake'
      },
      {
        title: '🎉 Sale Event Starting Tomorrow — 4th of July Sale',
        message: 'The 4th of July Sale kicks off tomorrow (07/03/2026) across all stores. Make sure your sale proposals are applied and your team is briefed.',
        link: '/sale-events'
      },
      {
        title: '📊 Weekly P&L Digest — Week of 06/16 – 06/22',
        message: "This week\'s combined revenue across all stores was $36,888.50. Net profit: $18,204.12 (49.3% margin). Test Merchant 2 led with $19,624.00 in revenue.",
        link: '/owner-pl'
      }
    ];

    for (const e of emails) {
      await sendNotificationEmail({ recipients: [to], title: e.title, message: e.message, link: e.link });
      await new Promise(r => setTimeout(r, 800));
    }

    res.json({ ok: true, sent: emails.length, to });
  } catch (err) {
    console.error('Demo email error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
