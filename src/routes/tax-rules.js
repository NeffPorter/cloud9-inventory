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
      .select('*, distributors(id, name)')
      .order('store_id');
    if (store_id) query = query.eq('store_id', store_id);
    const { data, error } = await query;
    if (error) throw error;

    const storeIds = [...new Set((data || []).map(r => r.store_id))];
    let storeNames = {};
    if (storeIds.length > 0) {
      const { data: stores } = await supabase.from('stores').select('id, name').in('id', storeIds);
      (stores || []).forEach(s => { storeNames[s.id] = s.name; });
    }

    const rules = (data || []).map(r => ({
      ...r,
      store_name: storeNames[r.store_id] || r.store_id,
      distributor_name: r.distributors?.name || r.distributor_id
    }));
    res.json({ rules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tax-rules — upsert a rule (admin only)
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const { store_id, distributor_id, tax_type, tax_value } = req.body;
    if (!store_id || !distributor_id || !tax_type || tax_value == null) {
      return res.status(400).json({ error: 'store_id, distributor_id, tax_type, and tax_value are required' });
    }
    if (!['percent', 'flat'].includes(tax_type)) {
      return res.status(400).json({ error: 'tax_type must be "percent" or "flat"' });
    }
    const { data, error } = await supabase
      .from('store_tax_rules')
      .upsert([{
        store_id,
        distributor_id,
        tax_type,
        tax_value: parseFloat(tax_value)
      }], { onConflict: 'store_id,distributor_id' })
      .select('*, distributors(id, name)')
      .single();
    if (error) throw error;
    res.json({ rule: { ...data, distributor_name: data.distributors?.name } });
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
