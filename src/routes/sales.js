const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
// Clover webhook verification + receiver
router.get('/webhook', (req, res) => {
  // Clover sends a verification challenge
  const challenge = req.query.challenge;
  if (challenge) {
    return res.send(challenge);
  }
  res.send('OK');
});

router.post('/webhook', (req, res) => {
  try {
    console.log('Webhook received:', JSON.stringify(req.body));
    // We'll process events here later
    res.send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('ERROR');
  }
});

router.get('/test', (req, res) => {
  res.json({ message: 'Sales routes working!' });
});
// Get sales overview data
router.get('/overview', auth, async (req, res) => {
  try {
    const { start, end, store_id } = req.query;

    const startDate = new Date(start || new Date().setHours(0,0,0,0));
    const endDate = new Date(end || new Date().setHours(23,59,59,999));

    // Calculate previous period
    const periodMs = endDate - startDate;
    const prevStart = new Date(startDate - periodMs);
    const prevEnd = new Date(startDate);

    // Build query
    let query = supabase
      .from('sales_log')
      .select('*')
      .gte('created_at', startDate.toISOString())
      .lte('created_at', endDate.toISOString());

    let prevQuery = supabase
      .from('sales_log')
      .select('*')
      .gte('created_at', prevStart.toISOString())
      .lte('created_at', prevEnd.toISOString());

    // Filter by store if manager or if admin selected a store
    if (req.user.role === 'manager' && req.user.store_id) {
      query = query.eq('store_id', req.user.store_id);
      prevQuery = prevQuery.eq('store_id', req.user.store_id);
    } else if (store_id) {
      query = query.eq('store_id', store_id);
      prevQuery = prevQuery.eq('store_id', store_id);
    }

    const [{ data: current }, { data: previous }] = await Promise.all([
      query, prevQuery
    ]);

    const calcTotals = (rows) => {
      let gross = 0, net = 0, tax = 0, discounts = 0,
          tips = 0, totalCost = 0, orders = 0, refunds = 0;

      (rows || []).forEach(row => {
        if (row.type === 'Refund') {
          refunds += Math.abs(row.net || 0);
        } else {
          gross += row.gross || 0;
          net += row.net || 0;
          tax += Math.abs(row.tax || 0);
          discounts += Math.abs(row.discounts || 0);
          tips += row.tips || 0;
          totalCost += row.total_cost || 0;
          orders++;
        }
      });

      const grossProfit = net - totalCost;
      const margin = net > 0 ? grossProfit / net : 0;
      const avgTicket = orders > 0 ? net / orders : 0;

      return { gross, net, tax, discounts, tips, totalCost, orders, refunds, grossProfit, margin, avgTicket };
    };

    const currentTotals = calcTotals(current);
    const previousTotals = calcTotals(previous);

    // Build daily chart data
    const dailyMap = {};
    const prevDailyMap = {};

    (current || []).forEach(row => {
      if (row.type === 'Refund') return;
      const day = new Date(row.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (!dailyMap[day]) dailyMap[day] = 0;
      dailyMap[day] += row.net || 0;
    });

    (previous || []).forEach(row => {
      if (row.type === 'Refund') return;
      const day = new Date(row.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (!prevDailyMap[day]) prevDailyMap[day] = 0;
      prevDailyMap[day] += row.net || 0;
    });

    res.json({
      current: currentTotals,
      previous: previousTotals,
      chartData: {
        current: dailyMap,
        previous: prevDailyMap
      }
    });

  } catch (err) {
    console.error('Sales overview error:', err);
    res.status(500).json({ error: 'Failed to load sales data' });
  }
});

// Get per-store breakdown
router.get('/by-store', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { start, end } = req.query;
    const startDate = new Date(start || new Date().setHours(0,0,0,0));
    const endDate = new Date(end || new Date().setHours(23,59,59,999));

    const { data: stores } = await supabase.from('stores').select('*').order('name');
    const { data: sales } = await supabase
      .from('sales_log')
      .select('*')
      .gte('created_at', startDate.toISOString())
      .lte('created_at', endDate.toISOString());

    const storeMap = {};
    (stores || []).forEach(s => {
      storeMap[s.id] = {
        name: s.name,
        gross: 0, net: 0, tax: 0,
        discounts: 0, refunds: 0,
        tips: 0, totalCost: 0,
        orders: 0
      };
    });

    (sales || []).forEach(row => {
      if (!storeMap[row.store_id]) return;
      const s = storeMap[row.store_id];
      if (row.type === 'Refund') {
        s.refunds += Math.abs(row.net || 0);
      } else {
        s.gross += row.gross || 0;
        s.net += row.net || 0;
        s.tax += Math.abs(row.tax || 0);
        s.discounts += Math.abs(row.discounts || 0);
        s.tips += row.tips || 0;
        s.totalCost += row.total_cost || 0;
        s.orders++;
      }
    });

    const result = Object.values(storeMap).map(s => ({
      ...s,
      grossProfit: s.net - s.totalCost,
      margin: s.net > 0 ? (s.net - s.totalCost) / s.net : 0,
      avgTicket: s.orders > 0 ? s.net / s.orders : 0
    }));

    res.json({ stores: result });
  } catch (err) {
    console.error('Sales by store error:', err);
    res.status(500).json({ error: 'Failed to load store sales' });
  }
});

module.exports = router;