const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../lib/supabase');
const multer = require('multer');
const { isHim } = require('../lib/roles');

// Multer 2.x: store in memory so we can pipe to Supabase Storage
const upload = multer({ storage: multer.memoryStorage, limits: { fileSize: 10 * 1024 * 1024 } });

const STORE_ROLES = ['regional_manager', 'him', 'admin', 'gm', 'store_user'];

function requireStoreAccess(req, res, next) {
  if (!STORE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// Only GM, HIM, and Regional Manager can write expenses
function requireGmOrAdmin(req, res, next) {
  if (!['regional_manager', 'him', 'admin', 'gm'].includes(req.user.role)) return res.status(403).json({ error: 'GM or admin only' });
  next();
}

// ── GET /api/store-expenses?store_id=&start=&end= ─────────────────────────────
router.get('/', auth, requireStoreAccess, async (req, res) => {
  try {
    const { store_id, start, end } = req.query;

    // Non-admins can only see their own store
    const effectiveStoreId = isHim(req.user.role) ? (store_id || null) : req.user.store_id;
    if (!effectiveStoreId) return res.status(400).json({ error: 'store_id required' });

    let query = supabase
      .from('store_expenses')
      .select('*, users(name)')
      .eq('store_id', effectiveStoreId)
      .order('expense_date', { ascending: false });

    if (start) query = query.gte('expense_date', start);
    if (end) query = query.lte('expense_date', end);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Compute next occurrence date for a recurring expense
function computeNextDate(frequency, day, fromDate) {
  const d = fromDate ? new Date(fromDate) : new Date();
  if (frequency === 'monthly') {
    // Next month, same day
    const next = new Date(d.getFullYear(), d.getMonth() + 1, Math.min(day, 28));
    return next.toISOString().slice(0, 10);
  }
  if (frequency === 'weekly') {
    // Next occurrence of weekday (0=Sun, 6=Sat)
    const next = new Date(d);
    const diff = (day - d.getDay() + 7) % 7 || 7;
    next.setDate(d.getDate() + diff);
    return next.toISOString().slice(0, 10);
  }
  if (frequency === 'yearly') {
    // Same month/day next year
    const next = new Date(d.getFullYear() + 1, d.getMonth(), Math.min(day, 28));
    return next.toISOString().slice(0, 10);
  }
  return null;
}

// ── POST /api/store-expenses — create expense (with optional receipt upload) ──
router.post('/', auth, requireGmOrAdmin, upload.single('receipt'), async (req, res) => {
  try {
    const { store_id, category, description, amount, expense_date,
            is_recurring, recur_frequency, recur_day } = req.body;

    const effectiveStoreId = isHim(req.user.role) ? store_id : req.user.store_id;
    if (!effectiveStoreId) return res.status(400).json({ error: 'store_id required' });
    if (!category || !amount || !expense_date) return res.status(400).json({ error: 'category, amount, and expense_date are required' });

    let receipt_url = null;
    let receipt_filename = null;

    // Upload receipt to Supabase Storage if provided
    if (req.file) {
      const filename = `${effectiveStoreId}/${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

      const { error: uploadErr } = await supabase.storage
        .from('expense-receipts')
        .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

      if (uploadErr) throw uploadErr;

      const { data: signedData } = await supabase.storage
        .from('expense-receipts')
        .createSignedUrl(filename, 60 * 60 * 24 * 365 * 10);

      receipt_url = signedData?.signedUrl || null;
      receipt_filename = req.file.originalname;
    }

    const recurring = is_recurring === 'true' || is_recurring === true;
    const dayNum = recur_day ? parseInt(recur_day) : null;
    const recur_next_date = recurring && recur_frequency && dayNum
      ? computeNextDate(recur_frequency, dayNum, expense_date)
      : null;

    const { data, error } = await supabase.from('store_expenses').insert({
      store_id: effectiveStoreId,
      category,
      description: description || null,
      amount: parseFloat(amount),
      expense_date,
      receipt_url,
      receipt_filename,
      created_by: req.user.id,
      is_recurring: recurring,
      recur_frequency: recurring ? recur_frequency : null,
      recur_day: recurring ? dayNum : null,
      recur_next_date
    }).select().single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Create expense error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/store-expenses/:id ───────────────────────────────────────────────
router.put('/:id', auth, requireGmOrAdmin, async (req, res) => {
  try {
    const { category, description, amount, expense_date } = req.body;
    const { data, error } = await supabase.from('store_expenses')
      .update({ category, description, amount: parseFloat(amount), expense_date, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/store-expenses/:id ───────────────────────────────────────────
router.delete('/:id', auth, requireGmOrAdmin, async (req, res) => {
  try {
    // Clean up receipt file from storage if exists
    const { data: expense } = await supabase.from('store_expenses').select('receipt_url').eq('id', req.params.id).single();
    if (expense?.receipt_url) {
      // Extract path from signed URL
      try {
        const url = new URL(expense.receipt_url);
        const pathParts = url.pathname.split('/expense-receipts/');
        if (pathParts[1]) {
          await supabase.storage.from('expense-receipts').remove([decodeURIComponent(pathParts[1].split('?')[0])]);
        }
      } catch {}
    }

    const { error } = await supabase.from('store_expenses').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/store-expenses/summary?store_id=&start=&end= ────────────────────
// Returns totals by category — used by P&L and GM dashboard
router.get('/summary', auth, requireStoreAccess, async (req, res) => {
  try {
    const { store_id, start, end } = req.query;
    const effectiveStoreId = isHim(req.user.role) ? (store_id || null) : req.user.store_id;
    if (!effectiveStoreId && !isHim(req.user.role)) return res.status(400).json({ error: 'store_id required' });

    let query = supabase.from('store_expenses').select('category, amount, store_id');
    if (effectiveStoreId) query = query.eq('store_id', effectiveStoreId);
    if (start) query = query.gte('expense_date', start);
    if (end) query = query.lte('expense_date', end);

    const { data, error } = await query;
    if (error) throw error;

    const summary = {};
    let total = 0;
    for (const row of data || []) {
      summary[row.category] = (summary[row.category] || 0) + parseFloat(row.amount);
      total += parseFloat(row.amount);
    }
    res.json({ by_category: summary, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Recurring expense cron — run daily, auto-create entries ──────────────────
async function runRecurringExpenseCron() {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Find all recurring templates where next date is today or overdue
    const { data: templates, error } = await supabase
      .from('store_expenses')
      .select('*')
      .eq('is_recurring', true)
      .lte('recur_next_date', today);

    if (error) throw error;
    if (!templates?.length) return;

    console.log(`[RecurringExpenses] Processing ${templates.length} template(s)`);

    for (const tmpl of templates) {
      try {
        // Create the new expense entry for this period
        await supabase.from('store_expenses').insert({
          store_id: tmpl.store_id,
          category: tmpl.category,
          description: tmpl.description,
          amount: tmpl.amount,
          expense_date: tmpl.recur_next_date,
          created_by: tmpl.created_by,
          recur_source_id: tmpl.id,
          is_recurring: false
        });

        // Advance the next date on the template
        const nextDate = computeNextDate(tmpl.recur_frequency, tmpl.recur_day, tmpl.recur_next_date);
        await supabase.from('store_expenses')
          .update({ recur_next_date: nextDate })
          .eq('id', tmpl.id);

        console.log(`[RecurringExpenses] Created ${tmpl.category} $${tmpl.amount} for store ${tmpl.store_id} on ${tmpl.recur_next_date}`);
      } catch (err) {
        console.error(`[RecurringExpenses] Failed for template ${tmpl.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[RecurringExpenses] Cron error:', err.message);
  }
}

router.runRecurringExpenseCron = runRecurringExpenseCron;
module.exports = router;
