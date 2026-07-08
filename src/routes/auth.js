const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const auth = require('../middleware/auth');
const supabase = require('../lib/supabase');
const { isUserAdmin } = require('../lib/roles');

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://cloud9systems.up.railway.app';


// Login — accepts email or username
router.post('/login', async (req, res) => {
  const { email, password } = req.body; // 'email' field accepts either email or username

  try {
    // Try email first (case-insensitive), fall back to username
    let { data: user } = await supabase
      .from('users').select('*').ilike('email', email).maybeSingle();

    if (!user) {
      const { data: byUsername } = await supabase
        .from('users').select('*').ilike('username', email).maybeSingle();
      user = byUsername;
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        store_id: user.store_id
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        store_id: user.store_id
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
// Get all users (admin only)
router.get('/users', auth, async (req, res) => {
  try {
    if (!isUserAdmin(req.user.role)) {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { data, error } = await supabase
      .from('users')
      .select('id, email, name, role, store_id, username, created_at')
      .order('name');

    if (error) throw error;
    res.json({ users: data });
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// Create new user (admin only)
router.post('/users', auth, async (req, res) => {
  try {
    if (!isUserAdmin(req.user.role)) {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { email, password, name, role, store_id, username } = req.body;
    if (!email || !password || !name || !role) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const { data, error } = await supabase
      .from('users')
      .insert([{ email, password_hash, name, role, store_id: store_id || null, username: username || null }])
      .select('id, email, name, role, store_id, username')
      .single();

    if (error) throw error;
    res.json({ user: data });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: err.message || 'Failed to create user' });
  }
});

// Update user (admin only)
router.put('/users/:id', auth, async (req, res) => {
  try {
    if (!isUserAdmin(req.user.role)) {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { name, role, store_id, username } = req.body;

    const { data, error } = await supabase
      .from('users')
      .update({ name, role, store_id: store_id || null, username: username || null })
      .eq('id', req.params.id)
      .select('id, email, name, role, store_id, username')
      .single();

    if (error) throw error;
    res.json({ user: data });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Delete user (admin only)
router.delete('/users/:id', auth, async (req, res) => {
  try {
    if (!isUserAdmin(req.user.role)) {
      return res.status(403).json({ error: 'Admin only' });
    }

    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "You can't delete yourself" });
    }

    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});


// Get own profile + notification prefs
router.get('/me', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, email, name, role, store_id, username, notification_prefs')
      .eq('id', req.user.id)
      .single();
    if (error) throw error;
    res.json({ user: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update own password and/or notification prefs
router.put('/me', auth, async (req, res) => {
  try {
    const { current_password, new_password, notification_prefs } = req.body;
    const updates = {};

    if (new_password) {
      const { data: user } = await supabase.from('users').select('password_hash').eq('id', req.user.id).single();
      const valid = await bcrypt.compare(current_password || '', user.password_hash);
      if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
      updates.password_hash = await bcrypt.hash(new_password, 10);
    }

    if (notification_prefs !== undefined) {
      updates.notification_prefs = notification_prefs;
    }

    if (!Object.keys(updates).length) return res.json({ success: true });

    const { error } = await supabase.from('users').update(updates).eq('id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test email (admin only) — hit GET /api/auth/test-email?to=you@example.com
router.get('/test-email', auth, async (req, res) => {
  if (!isUserAdmin(req.user.role)) return res.status(403).json({ error: 'Admin only' });
  try {
    const { sendEmail } = require('../services/email');
    const to = req.query.to || req.user.email;
    await sendEmail({
      to,
      subject: 'Cloud 9 Vapor — Email Test',
      html: '<p>This is a test email from Cloud 9 Vapor. If you received this, email is working correctly.</p>',
      text: 'This is a test email from Cloud 9 Vapor.'
    });
    res.json({ success: true, message: `Test email sent to ${to}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Heartbeat — updates last_seen for presence tracking
router.put('/heartbeat', auth, async (req, res) => {
  try {
    await supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('id', req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Heartbeat failed' });
  }
});

// Get all users with presence (admin/him/rm only)
router.get('/presence', auth, async (req, res) => {
  try {
    if (!['admin', 'him', 'regional_manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { data, error } = await supabase
      .from('users')
      .select('id, last_seen');
    if (error) throw error;
    res.json({ presence: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch presence' });
  }
});

module.exports = router;
