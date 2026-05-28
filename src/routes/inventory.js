const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Get stores based on user role
router.get('/stores', auth, async (req, res) => {
  try {
    let query = supabase.from('stores').select('*').order('name');

    // Managers only see their store
    if (req.user.role === 'manager' && req.user.store_id) {
      query = query.eq('id', req.user.store_id);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ stores: data });
  } catch (err) {
    console.error('Get stores error:', err);
    res.status(500).json({ error: 'Failed to load stores' });
  }
});

module.exports = router;