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
// Add a new store (admin only)
router.post('/stores', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { name, merchant_id, api_token } = req.body;
    if (!name || !merchant_id || !api_token) {
      return res.status(400).json({ error: 'Name, Merchant ID and API Token are required' });
    }

    const { data, error } = await supabase
      .from('stores')
      .insert([{ name, merchant_id, api_token }])
      .select()
      .single();

    if (error) throw error;

    // Create default settings for the store
    await supabase.from('store_settings').insert([{
      store_id: data.id,
      lead_time: 5,
      buffer_days: 14
    }]);

    res.json({ store: data });
  } catch (err) {
    console.error('Add store error:', err);
    res.status(500).json({ error: 'Failed to add store' });
  }
});
// Delete a store (admin only)
router.delete('/stores/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { error } = await supabase
      .from('stores')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('Delete store error:', err);
    res.status(500).json({ error: 'Failed to delete store' });
  }
});
module.exports = router;