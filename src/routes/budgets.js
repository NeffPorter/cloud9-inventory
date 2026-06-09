const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// Get the Monday of whichever week contains the given date
function getMondayOf(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function toDateStr(date) {
  return date.toISOString().split('T')[0];
}

async function recalcTotal(budgetId) {
  const { data: invoices } = await supabase
    .from('budget_invoices')
    .select('invoice_amount')
    .eq('budget_id', budgetId);

  const total = Math.round(
    (invoices || []).reduce((sum, inv) => sum + (inv.invoice_amount || 0), 0) * 100
  ) / 100;

  const { data: budget } = await supabase
    .from('weekly_budgets')
    .select('status, budget_30')
    .eq('id', budgetId)
    .single();

  if (!budget) return total;

  let newStatus = budget.status;
  // Only auto-transition between active ↔ pending_approval;
  // leave complete / approved_extended alone
  if (newStatus === 'active' && total > budget.budget_30) {
    newStatus = 'pending_approval';
  } else if (newStatus === 'pending_approval' && total <= budget.budget_30) {
    newStatus = 'active';
  }

  await supabase
    .from('weekly_budgets')
    .update({ total_invoiced: total, status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', budgetId);

  return total;
}

// ─── List budgets ─────────────────────────────────────────────────────────────

router.get('/', auth, async (req, res) => {
  try {
    const { store_id } = req.query;

    let query = supabase
      .from('weekly_budgets')
      .select('*')
      .order('week_start', { ascending: false });

    if (req.user.role === 'manager') {
      query = query.eq('store_id', req.user.store_id);
    } else if (store_id) {
      query = query.eq('store_id', store_id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ budgets: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get or auto-create current week's budget ─────────────────────────────────

// IMPORTANT: must be before /:id
router.get('/current/:store_id', auth, async (req, res) => {
  try {
    const { store_id } = req.params;
    if (req.user.role === 'manager' && req.user.store_id !== store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const now = new Date();
    const weekStart = getMondayOf(now);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);

    const weekStartStr = toDateStr(weekStart);
    const weekEndStr = toDateStr(weekEnd);

    // Check if budget already exists for this week
    const { data: existing } = await supabase
      .from('weekly_budgets')
      .select('*')
      .eq('store_id', store_id)
      .eq('week_start', weekStartStr)
      .single();

    if (existing) return res.json({ budget: existing, created: false });

    // Calculate prior week net sales
    const prevStart = new Date(weekStart);
    prevStart.setDate(prevStart.getDate() - 7);
    const prevEnd = new Date(weekStart);
    prevEnd.setDate(prevEnd.getDate() - 1);
    prevEnd.setHours(23, 59, 59, 999);

    const { data: salesRows } = await supabase
      .from('sales_log')
      .select('net, type')
      .eq('store_id', store_id)
      .gte('created_at', prevStart.toISOString())
      .lte('created_at', prevEnd.toISOString());

    let prevNet = 0;
    (salesRows || []).forEach(row => {
      prevNet += row.type === 'Refund' ? -Math.abs(row.net || 0) : (row.net || 0);
    });
    prevNet = Math.max(0, Math.round(prevNet * 100) / 100);

    const budget30 = Math.round(prevNet * 0.30 * 100) / 100;
    const budget45 = Math.round(prevNet * 0.45 * 100) / 100;

    const { data: created, error } = await supabase
      .from('weekly_budgets')
      .insert([{
        store_id,
        week_start: weekStartStr,
        week_end: weekEndStr,
        prev_week_start: toDateStr(prevStart),
        prev_week_end: toDateStr(prevEnd),
        prev_week_net_sales: prevNet,
        budget_30: budget30,
        budget_45: budget45,
        total_invoiced: 0,
        status: 'active'
      }])
      .select()
      .single();

    if (error) throw error;
    res.json({ budget: created, created: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get single budget with invoices ─────────────────────────────────────────

router.get('/:id', auth, async (req, res) => {
  try {
    const { data: budget, error } = await supabase
      .from('weekly_budgets')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !budget) return res.status(404).json({ error: 'Budget not found' });
    if (req.user.role === 'manager' && req.user.store_id !== budget.store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: invoices } = await supabase
      .from('budget_invoices')
      .select('*')
      .eq('budget_id', req.params.id)
      .order('created_at');

    // Get store name
    const { data: store } = await supabase
      .from('stores')
      .select('name')
      .eq('id', budget.store_id)
      .single();

    res.json({ budget, invoices: invoices || [], store_name: store?.name || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update budget (mark complete, notes) ─────────────────────────────────────

router.put('/:id', auth, async (req, res) => {
  try {
    const { status, notes } = req.body;

    const { data: budget } = await supabase
      .from('weekly_budgets').select('store_id, status').eq('id', req.params.id).single();

    if (!budget) return res.status(404).json({ error: 'Budget not found' });
    if (req.user.role === 'manager' && req.user.store_id !== budget.store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    // Managers can only mark complete; admins can set any status
    if (req.user.role === 'manager' && status && status !== 'complete') {
      return res.status(403).json({ error: 'Managers can only mark budgets as complete' });
    }

    const updates = { updated_at: new Date().toISOString() };
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;

    const { data, error } = await supabase
      .from('weekly_budgets').update(updates).eq('id', req.params.id).select().single();

    if (error) throw error;
    res.json({ budget: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: approve extended budget ──────────────────────────────────────────

router.put('/:id/approve', auth, adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('weekly_budgets')
      .update({
        status: 'approved_extended',
        approved_by: req.user.name || req.user.email,
        approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ budget: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Add invoice line item ────────────────────────────────────────────────────

router.post('/:id/invoices', auth, async (req, res) => {
  try {
    const { distributor_id, distributor_name, invoice_amount, invoice_pdf_url, invoice_pdf_name, notes } = req.body;

    const { data: budget } = await supabase
      .from('weekly_budgets').select('store_id, status, budget_30, budget_45').eq('id', req.params.id).single();

    if (!budget) return res.status(404).json({ error: 'Budget not found' });
    if (req.user.role === 'manager' && req.user.store_id !== budget.store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (budget.status === 'complete') {
      return res.status(400).json({ error: 'Cannot add invoices to a completed budget' });
    }

    const { data: invoice, error } = await supabase
      .from('budget_invoices')
      .insert([{
        budget_id: req.params.id,
        distributor_id: distributor_id || null,
        distributor_name: distributor_name || null,
        invoice_amount: Math.round((parseFloat(invoice_amount) || 0) * 100) / 100,
        invoice_pdf_url: invoice_pdf_url || null,
        invoice_pdf_name: invoice_pdf_name || null,
        notes: notes || null
      }])
      .select()
      .single();

    if (error) throw error;

    const newTotal = await recalcTotal(req.params.id);

    // Refresh budget status
    const { data: updatedBudget } = await supabase
      .from('weekly_budgets').select('status').eq('id', req.params.id).single();

    res.json({ invoice, new_total: newTotal, new_status: updatedBudget?.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update invoice ───────────────────────────────────────────────────────────

router.put('/:id/invoices/:invoiceId', auth, async (req, res) => {
  try {
    const { distributor_id, distributor_name, invoice_amount, invoice_pdf_url, invoice_pdf_name, notes } = req.body;

    const { data: budget } = await supabase
      .from('weekly_budgets').select('store_id').eq('id', req.params.id).single();

    if (!budget) return res.status(404).json({ error: 'Budget not found' });
    if (req.user.role === 'manager' && req.user.store_id !== budget.store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updates = { updated_at: new Date().toISOString() };
    if (distributor_id !== undefined) updates.distributor_id = distributor_id || null;
    if (distributor_name !== undefined) updates.distributor_name = distributor_name;
    if (invoice_amount !== undefined) updates.invoice_amount = Math.round((parseFloat(invoice_amount) || 0) * 100) / 100;
    if (invoice_pdf_url !== undefined) updates.invoice_pdf_url = invoice_pdf_url;
    if (invoice_pdf_name !== undefined) updates.invoice_pdf_name = invoice_pdf_name;
    if (notes !== undefined) updates.notes = notes;

    const { data, error } = await supabase
      .from('budget_invoices').update(updates).eq('id', req.params.invoiceId).select().single();

    if (error) throw error;

    const newTotal = await recalcTotal(req.params.id);
    const { data: updatedBudget } = await supabase
      .from('weekly_budgets').select('status').eq('id', req.params.id).single();

    res.json({ invoice: data, new_total: newTotal, new_status: updatedBudget?.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete invoice ───────────────────────────────────────────────────────────

router.delete('/:id/invoices/:invoiceId', auth, async (req, res) => {
  try {
    const { data: budget } = await supabase
      .from('weekly_budgets').select('store_id').eq('id', req.params.id).single();

    if (!budget) return res.status(404).json({ error: 'Budget not found' });
    if (req.user.role === 'manager' && req.user.store_id !== budget.store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await supabase.from('budget_invoices').delete().eq('id', req.params.invoiceId);

    const newTotal = await recalcTotal(req.params.id);
    res.json({ success: true, new_total: newTotal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Upload invoice PDF (base64) to Supabase Storage ─────────────────────────

router.post('/:id/upload-pdf', auth, async (req, res) => {
  try {
    const { file_base64, file_name, file_type } = req.body;
    if (!file_base64 || !file_name) return res.status(400).json({ error: 'file_base64 and file_name required' });

    const { data: budget } = await supabase
      .from('weekly_budgets').select('store_id').eq('id', req.params.id).single();

    if (!budget) return res.status(404).json({ error: 'Budget not found' });
    if (req.user.role === 'manager' && req.user.store_id !== budget.store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const buffer = Buffer.from(file_base64, 'base64');
    const safeName = file_name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${budget.store_id}/${req.params.id}/${Date.now()}-${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from('invoices')
      .upload(storagePath, buffer, {
        contentType: file_type || 'application/pdf',
        upsert: false
      });

    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage.from('invoices').getPublicUrl(storagePath);

    res.json({ url: urlData.publicUrl, path: storagePath, name: file_name });
  } catch (err) {
    console.error('PDF upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
