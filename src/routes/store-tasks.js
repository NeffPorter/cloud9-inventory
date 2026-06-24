const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const auth = require('../middleware/auth');
const { notify } = require('../services/notify');

// GET /api/store-tasks?store_id=xxx — get to-do list for a store
router.get('/', auth, async (req, res) => {
  try {
    const { store_id, status } = req.query;
    if (!store_id) return res.status(400).json({ error: 'store_id required' });

    let query = supabase
      .from('store_tasks')
      .select('*')
      .eq('store_id', store_id)
      .order('due_date', { ascending: true, nullsFirst: false });

    if (status) query = query.eq('status', status);
    else query = query.neq('status', 'completed');

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/store-tasks/:id — update task status
router.put('/:id', auth, async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabase
      .from('store_tasks')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select().single();
    if (error) throw error;
    res.json({ success: true, task: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Monthly stocktake cron — generates tasks for categories not yet done this month
async function runStocktakeCron() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

  // Get all active stores
  const { data: stores } = await supabase.from('stores').select('id, name');
  if (!stores?.length) return;

  for (const store of stores) {
    // Get all categories for this store
    const { data: items } = await supabase
      .from('inventory_items')
      .select('category')
      .eq('store_id', store.id)
      .not('category', 'is', null);

    const categories = [...new Set((items || []).map(i => i.category).filter(Boolean))];
    if (!categories.length) continue;

    // Get stocktake reports done this month for this store
    const { data: reports } = await supabase
      .from('stock_take_reports')
      .select('categories')
      .eq('store_id', store.id)
      .gte('created_at', monthStart)
      .in('status', ['completed', 'approved']);

    const coveredThisMonth = new Set();
    for (const r of (reports || [])) {
      (r.categories || []).forEach(c => coveredThisMonth.add(c));
    }

    const newCategories = [];
    for (const category of categories) {
      if (coveredThisMonth.has(category)) continue;

      const taskTitle = `Monthly Stocktake: ${category}`;
      const { data: existingTask } = await supabase
        .from('store_tasks')
        .select('id, status')
        .eq('store_id', store.id)
        .eq('task_type', 'stocktake')
        .eq('title', taskTitle)
        .gte('created_at', monthStart)
        .single();

      if (existingTask) continue;

      await supabase.from('store_tasks').insert({
        store_id: store.id,
        task_type: 'stocktake',
        title: taskTitle,
        description: `Perform a stock take for the "${category}" category. Required monthly.`,
        due_date: monthEnd,
        status: 'pending'
      });

      newCategories.push(category);
    }

    // Email the store's GM/IM about new stocktake tasks
    if (newCategories.length > 0) {
      notify({
        type: 'stocktake_due',
        title: '📋 Monthly Stock Takes Due',