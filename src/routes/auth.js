const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const auth = require('../middleware/auth');
const supabase = require('../lib/supabase');
const { isUserAdmin } = require('../lib/roles');

const CLOVER_APP_ID     = process.env.CLOVER_APP_ID;
const CLOVER_APP_SECRET = process.env.CLOVER_APP_SECRET;
const APP_BASE_URL      = process.env.APP_BASE_URL || 'https://cloud9-inventory-production.up.railway.app';
const CLOVER_API_BASE   = 'https://api.clover.com';
const CLOVER_WWW_BASE   = 'https://www.clover.com';

// In-memory nonce store (nonce -> { userId, exp })
const oauthNonces = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of oauthNonces) { if (v.exp < now) oauthNonces.delete(k); }
}, 60_000);

// ── Store invite: send email ──────────────────────────────────────────────────
router.post('/store-invite', auth, async (req, res) => {
  if (!isUserAdmin(req.user.role)) return res.status(403).json({ error: 'Admin only' });

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Store email is required' });

  const inviteToken = jwt.sign(
    { type: 'store-invite', email },
    process.env.JWT_SECRET,
    { expiresIn: '48h' }
  );

  const connectUrl = `${APP_BASE_URL}/connect-store?token=${inviteToken}`;

  try {
    const { sendEmail } = require('../services/email');
    await sendEmail({
      to: email,
      subject: 'Cloud 9 Vapor — Connect Your Clover Store',
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;">
          <div style="background:#1a1a2e;padding:16px 24px;border-radius:12px 12px 0 0;">
            <h1 style="color:white;margin:0;font-size:18px;">Cloud 9 Vapor</h1>
          </div>
          <div style="background:white;border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px;">
            <h2 style="margin:0 0 12px;font-size:17px;color:#1a1a1a;">Connect Your Store to Cloud 9 Inventory</h2>
            <p style="color:#555;line-height:1.6;margin:0 0 20px;">You've been invited to connect your Clover store to the Cloud 9 Vapor inventory system. Click the button below to complete the setup.</p>
            <p style="margin:0 0 20px;"><a href="${connectUrl}" style="background:#2f5597;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">Connect My Store</a></p>
            <p style="color:#777;font-size:13px;margin:0 0 8px;">You'll need the following from your Clover Developer Dashboard:</p>
            <ul style="color:#777;font-size:13px;margin:0 0 16px;padding-left:20px;">
              <li>Your Merchant ID</li>
              <li>Your API Token</li>
            </ul>
            <p style="color:#aaa;font-size:12px;margin:0;">This link expires in 48 hours.</p>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
            <p style="color:#aaa;font-size:12px;margin:0;">Cloud 9 Vapor Inventory System</p>
          </div>
        </div>`
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Store invite email error:', err.message);
    res.status(500).json({ error: 'Failed to send invite email' });
  }
});

// ── Store invite: complete connection (public — no auth required) ──────────────
router.post('/store-connect', async (req, res) => {
  const { invite_token, store_name, merchant_id, api_token } = req.body;

  if (!invite_token || !store_name || !merchant_id || !api_token) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    const payload = jwt.verify(invite_token, process.env.JWT_SECRET);
    if (payload.type !== 'store-invite') throw new Error('Wrong token type');
  } catch {
    return res.status(400).json({ error: 'Invite link has expired or is invalid. Ask your admin to resend.' });
  }

  const { data: store, error: storeErr } = await supabase
    .from('stores')
    .upsert({ merchant_id, name: store_name, api_token, refresh_token: null, token_expires_at: null }, { onConflict: 'merchant_id' })
    .select()
    .single();

  if (storeErr) {
    console.error('store-connect upsert error:', storeErr);
    return res.status(500).json({ error: 'Failed to save store. Please try again.' });
  }

  const { data: existing } = await supabase.from('store_settings').select('id').eq('store_id', store.id).maybeSingle();
  if (!existing) {
    await supabase.from('store_settings').insert([{ store_id: store.id, lead_time: 5, buffer_days: 14 }]);
  }

  res.json({ success: true });
});

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

    const bcrypt = require('bcryptjs');
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

module.exports = router;
