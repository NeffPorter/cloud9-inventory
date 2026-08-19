const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../lib/supabase');
const { isHim } = require('../lib/roles');

function adminOnly(req, res, next) {
  if (!isHim(req.user.role)) return res.status(403).json({ error: 'Admin only' });
  next();
}

// GET /api/tax-rules?store_id=... — all rules, optionally filtered by store
router.get('/', auth, async (req, res) => {
  try {
    const { store_id } = req.query;
    let query = supabase
      .from('store_tax_rules')
      .select('*')
      .order('store_id')
      .order('category');
    if (store_id) query = query.eq('store_id', store_id);
    const { data, error } = await query;
    if (error) throw error;

    // Attach store names via a separate query so we don't need the PostgREST FK cache
    const storeIds = [...new Set((data || []).map(r => r.store_id))];
    let storeNames = {};
    if (storeIds.length > 0) {
      const { data: stores } = await supabase.from('stores').select('id, name').in('id', storeIds);
      (stores || []).forEach(s => { storeNames[s.id] = s.name; });
    }

    const rules = (data || []).map(r => ({ ...r, store_name: storeNames[r.store_id] || r.store_id }));
    res.json({ rules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tax-rules — upsert a rule (admin only)
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const { store_id, category, tax_pct, label } = req.body;
    if (!store_id || !category || tax_pct == null) {
      return res.status(400).json({ error: 'store_id, category, and tax_pct are required' });
    }
    const { data, error } = await supabase
      .from('store_tax_rules')
      .upsert([{
        store_id,
        category: category.trim(),
        tax_pct: parseFloat(tax_pct),
        label: label?.trim() || null
      }], { onConflict: 'store_id,category' })
      .select('*')
      .single();
    if (error) throw error;
    res.json({ rule: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/tax-rules/:id (admin only)
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { error } = await supabase
      .from('store_tax_rules')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
