const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');
const { fetchFullOrder, fetchOrderRefunds, fetchItem, pushStockToClover, extractLineItems, extractRefundedItems } = require('../services/clover');
const { calculateSuggestedOrder } = require('../services/suggested');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Webhook verification
router.get('/webhook', (req, res) => {
  const challenge = req.query.challenge;
  if (challenge) return res.send(challenge);
  res.send('OK');
});

// Webhook receiver
router.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const merchants = payload.merchants || {};

    for (const mid of Object.keys(merchants)) {
      const events = merchants[mid] || [];

      const { data: store } = await supabase
        .from('stores')
        .select('*')
        .eq('merchant_id', mid)
        .single();

      if (!store) { console.log('No store found for MID:', mid); continue; }

      for (const event of events) {
        const objectId = event.objectId || '';
        const eventType = (event.type || '').toUpperCase();
        const isOrderEvent = objectId.startsWith('O:') || eventType.includes('ORDER');
        const isPaymentEvent = objectId.startsWith('P:');
        const isInventoryEvent = objectId.startsWith('I:');

        if (isInventoryEvent) {
          await updateInventoryItem(store, objectId.replace('I:', ''));
          continue;
        }
        if (isOrderEvent) {
          await processOrderEvent(store, objectId);
          continue;
        }
        if (isPaymentEvent) {
          const isRefund = eventType.includes('REFUND') || eventType.includes('CREDIT');
          if (isRefund && event.data?.order?.id) {
            await processOrderEvent(store, event.data.order.id);
          }
        }
      }
    }
    res.send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('ERROR');
  }
});

async function processOrderEvent(store, orderId) {
  try {
    const cleanId = orderId.replace(/^O:/, '');

    const { data: existing } = await supabase
      .from('sales_log')
      .select('id')
      .eq('store_id', store.id)
      .eq('order_id', cleanId)
      .eq('type', 'Sale')
      .single();

    const fullOrder = await fetchFullOrder(store.merchant_id, store.api_token, cleanId);

    const isRefund = fullOrder.state === 'refunded' ||
                     fullOrder.paymentState === 'credited' ||
                     fullOrder.paymentState === 'PARTIALLY_REFUNDED' ||
                     (fullOrder.refundAmount || 0) > 0 ||
                     (fullOrder.refunds?.elements?.length > 0);

    if (!isRefund && existing) { console.log('Sale already logged:', cleanId); return; }

    let amount = (fullOrder.total || 0) / 100;
    let tax = 0;
    let tips = 0;

    (fullOrder.payments?.elements || []).forEach(p => {
      tax += (p.taxAmount || 0) / 100;
      tips += (p.tipAmount || 0) / 100;
    });

    let gross = 0;
    (fullOrder.lineItems?.elements || []).forEach(li => { gross += (li.price || 0) / 100; });
    if (gross === 0) gross = amount;

    let itemMap = {};
    let restockThisRefund = true;

    if (isRefund) {
      const refundsData = await fetchOrderRefunds(store.merchant_id, store.api_token, cleanId);
      const latestRefund = refundsData?.elements?.length > 0
        ? refundsData.elements[refundsData.elements.length - 1]
        : fullOrder.refunds?.elements?.[fullOrder.refunds.elements.length - 1];
      if (latestRefund) {
        amount = (latestRefund.amount || 0) / 100;
        tax = (latestRefund.taxAmount || 0) / 100;
        if ((latestRefund.reason || '').toLowerCase().includes('not restocked')) restockThisRefund = false;
      }
      itemMap = extractRefundedItems(fullOrder);
    } else {
      itemMap = extractLineItems(fullOrder);
    }

    const finalGross = isRefund ? -Math.abs(amount) : gross;
    const finalNet = isRefund ? -(Math.abs(amount) - tax) : (amount - tax);
    const finalTax = isRefund ? -Math.abs(tax) : tax;
    const finalTips = isRefund ? 0 : tips;
    const finalDiscounts = isRefund ? 0 : Math.max(0, gross - (amount - tax));
    const type = isRefund ? 'Refund' : 'Sale';
    const itemIds = Object.keys(itemMap);
    const itemSummary = itemIds.map(id => `${id} x${itemMap[id].qty}`).join(', ') || 'N/A';

    let totalCost = 0;
    for (const id of itemIds) {
      const { data: invItem } = await supabase
        .from('inventory_items').select('cost')
        .eq('id', id).eq('store_id', store.id).single();
      if (invItem) totalCost += (invItem.cost || 0) * itemMap[id].qty * (isRefund ? -1 : 1);
    }

    await supabase.from('sales_log').insert([{
      store_id: store.id, order_id: cleanId, type,
      gross: finalGross, net: finalNet, tax: finalTax,
      discounts: finalDiscounts, tips: finalTips,
      total_cost: totalCost, gross_profit: finalNet - totalCost,
      item_summary: itemSummary,
      status: isRefund ? (restockThisRefund ? 'Restocked' : 'Not Restocked') : 'OK'
    }]);

    console.log(`✅ Logged ${type} for store ${store.name}: $${finalNet.toFixed(2)}`);

    for (const id of itemIds) {
      if (isRefund && restockThisRefund) {
        await pushStockToClover(store.merchant_id, store.api_token, id, itemMap[id].qty);
      }
      await updateInventoryItem(store, id);
    }
  } catch (err) {
    console.error('processOrderEvent error:', err.message);
  }
}

async function updateInventoryItem(store, itemId) {
  try {
    const item = await fetchItem(store.merchant_id, store.api_token, itemId);
    if (!item || item.hidden || item.deleted || !item.name) return;

    const cloverQty = item.itemStock ? item.itemStock.quantity : 0;
    const cost = item.cost ? (item.cost / 100) : 0;
    const price = item.price ? (item.price / 100) : 0;
    const category = item.categories?.elements?.[0]?.name || 'No Category';
    const groupName = item.itemGroup?.name || '';

    const { data: settings } = await supabase
      .from('store_settings').select('*')
      .eq('store_id', store.id).single();

    const leadTime = settings?.lead_time || 5;
    const bufferDays = settings?.buffer_days || 14;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);

    const { data: salesRows } = await supabase
      .from('sales_log').select('item_summary, type')
      .eq('store_id', store.id).gte('created_at', cutoff.toISOString());

    let unitsSold = 0;
    (salesRows || []).forEach(row => {
      if (!row.item_summary || row.item_summary === 'N/A') return;
      row.item_summary.split(',').forEach(part => {
        const match = part.trim().match(/^([A-Z0-9]+)\s+x(\d+\.?\d*)/);
        if (match && match[1] === itemId) {
          unitsSold += row.type === 'Refund' ? -(parseFloat(match[2]) || 1) : (parseFloat(match[2]) || 1);
        }
      });
    });

    const suggested = calculateSuggestedOrder(cloverQty, Math.max(0, unitsSold), leadTime, bufferDays);

    await supabase.from('inventory_items').upsert([{
      id: itemId, store_id: store.id,
      category, group_name: groupName,
      variant_name: item.name, cost, price,
      clover_qty: cloverQty,
      suggested_order: suggested > 0 ? suggested : 0,
      last_synced: new Date().toISOString()
    }], { onConflict: 'id' });

    console.log(`📦 Updated item ${itemId} for ${store.name}: qty=${cloverQty}`);
  } catch (err) {
    console.error('updateInventoryItem error:', err.message);
  }
}

router.get('/test', (req, res) => {
  res.json({ message: 'Sales routes working!' });
});

router.get('/overview', auth, async (req, res) => {
  try {
    const { start, end, store_id } = req.query;
    const startDate = new Date(start || new Date().setHours(0,0,0,0));
    const endDate = new Date(end || new Date().setHours(23,59,59,999));
    const periodMs = endDate - startDate;
    const prevStart = new Date(startDate - periodMs);
    const prevEnd = new Date(startDate);

    let query = supabase.from('sales_log').select('*')
      .gte('created_at', startDate.toISOString())
      .lte('created_at', endDate.toISOString());

    let prevQuery = supabase.from('sales_log').select('*')
      .gte('created_at', prevStart.toISOString())
      .lte('created_at', prevEnd.toISOString());

    if (req.user.role === 'manager' && req.user.store_id) {
      query = query.eq('store_id', req.user.store_id);
      prevQuery = prevQuery.eq('store_id', req.user.store_id);
    } else if (store_id) {
      query = query.eq('store_id', store_id);
      prevQuery = prevQuery.eq('store_id', store_id);
    }

    const [{ data: current }, { data: previous }] = await Promise.all([query, prevQuery]);

    const calcTotals = (rows) => {
      let gross = 0, net = 0, tax = 0, discounts = 0, tips = 0, totalCost = 0, orders = 0, refunds = 0;
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
      current: calcTotals(current),
      previous: calcTotals(previous),
      chartData: { current: dailyMap, previous: prevDailyMap }
    });
  } catch (err) {
    console.error('Sales overview error:', err);
    res.status(500).json({ error: 'Failed to load sales data' });
  }
});

router.get('/by-store', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const { start, end } = req.query;
    const startDate = new Date(start || new Date().setHours(0,0,0,0));
    const endDate = new Date(end || new Date().setHours(23,59,59,999));

    const { data: stores } = await supabase.from('stores').select('*').order('name');
    const { data: sales } = await supabase.from('sales_log').select('*')
      .gte('created_at', startDate.toISOString())
      .lte('created_at', endDate.toISOString());

    const storeMap = {};
    (stores || []).forEach(s => {
      storeMap[s.id] = { name: s.name, gross: 0, net: 0, tax: 0, discounts: 0, refunds: 0, tips: 0, totalCost: 0, orders: 0 };
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