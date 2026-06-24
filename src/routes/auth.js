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

// ── Clover OAuth: start ──────────────────────────────────────────────────────
router.get('/clover/start', auth, async (req, res) => {
  if (!isUserAdmin(req.user.role)) return res.status(403).json({ error: 'Admin only' });
  if (!CLOVER_APP_ID) return res.status(500).json({ error: 'CLOVER_APP_ID not configured' });

  const nonce = crypto.randomBytes(16).toString('hex');
  oauthNonces.set(nonce, { userId: req.user.id, exp: Date.now() + 10 * 60 * 1000 });

  const redirectUri = `${APP_BASE_URL}/api/auth/clover/callback`;
  const url = `${CLOVER_WWW_BASE}/oauth/v2/authorize?client_id=${CLOVER_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${nonce}`;
  res.json({ url });
});

// ── Clover OAuth: callback ───────────────────────────────────────────────────
router.get('/clover/callback', async (req, res) => {
  const { merchant_id, code, state } = req.query;

  if (!code || !merchant_id) return res.redirect('/stores?error=missing_params');

  const nonceData = oauthNonces.get(state);
  if (!nonceData || nonceData.exp < Date.now()) return res.redirect('/stores?error=invalid_state');
  oauthNonces.delete(state);

  try {
    const redirectUri = `${APP_BASE_URL}/api/auth/clover/callback`;

    // Exchange code for tokens
    const tokenRes = await axios.post(`${CLOVER_API_BASE}/oauth/v2/token`, {
      client_id:     CLOVER_APP_ID,
      client_secret: CLOVER_APP_SECRET,
      code,
      grant_type:    'authorization_code',
      redirect_uri:  redirectUri
    });
    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const tokenExpiresAt = new Date(Date.now() + (expires_in || 3600) * 1000).toISOString();

    // Fetch merchant name from Clover
    let storeName = merchant_id;
    try {
      const mRes = await axios.get(`${CLOVER_API_BASE}/v3/merchants/${merchant_id}`,
        { headers: { Authorization: `Bearer ${access_token}` } });
      storeName = mRes.data.name || merchant_id;
    } catch { /* fall back to merchant_id */ }

    // Upsert store
    const { data: store, error: storeErr } = await supabase
      .from('stores')
      .upsert({ merchant_id, name: storeName, api_token: access_token, refresh_token, token_expires_at: tokenExpiresAt },
               { onConflict: 'merchant_id' })
      .select()
      .single();
    if (storeErr) throw storeErr;

    // Create store_settings if new store
    const { data: existing } = await supabase.from('store_settings').select('id').eq('store_id', store.id).maybeSingle();
    if (!existing) {
      await supabase.from('store_settings').insert([{ store_id: store.id, lead_time: 5, buffer_days: 14 }]);
    }

    res.redirect('/stores?connected=1');
  } catch (err) {
    console.error('Clover OAuth callback error:', err.response?.data || err.message);
    res.redirect('/stores?error=oauth_error');
  }
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

module.ex