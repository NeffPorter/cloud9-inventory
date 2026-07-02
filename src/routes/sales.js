const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { fetchFullOrder, fetchOrderRefunds, fetchItem, pushStockToClover, extractLineItems, extractRefundedItems, createCashSale, getCashTenderId, getValidApiToken } = require('../services/clover');
const { calculateSuggestedOrder } = require('../services/suggested');
const { notify } = require('../services/notify');
const supabase = require('../lib/supabase');
const { isHim, isOwnerLevel } = require('../lib/roles');

// Per-category low stock threshold is fetched dynamically in updateInventoryItem.

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
    const mids = Object.keys(merchants);

    if (mids.length === 0) return res.send('OK');

    for (const mid of mids) {
      const events = merchants[mid] || [];
      console.log(`[Webhook] MID=${mid} events=${events.length}`);

      const { data: store } = await supabase
        .from('stores')
        .select('*')
        .eq('merchant_id', mid)
        .single();

      if (!store) { console.log('[Webhook] No store found for MID:', mid); continue; }

      for (const event of events) {
        const objectId = event.objectId || '';
        const eventType = (event.type || '').toUpperCase();
        console.log(`[Webhook] Event type=${eventType} objectId=${objectId}`);

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
          } else if (!isRefund) {
            // Payment event — treat as order event to catch paid orders
            console.log('[Webhook] Payment event, no order id in data:', JSON.stringify(event));
          }
        }
      }
    }
    res.send('OK');
  } catch (err) {
    console.error('[Webhook] Error:', err);
    res.status(500).send('ERROR');
  }
});


async function processOrderEvent(store, orderId) {
  try {
    const cleanId = orderId.replace(/^O:/, '');
    console.log(`[processOrderEvent] store=${store.name} orderId=${cleanId}`);

    const { data: existingSales } = await supabase
      .from('sales_log')
      .select('id, type')
      .eq('store_id', store.id)
      .eq('order_id', cleanId);

    const apiToken = await getValidApiToken(store);
    console.log(`[processOrderEvent] fetching order from Clover...`);
    const fullOrder = await fetchFullOrder(store.merchant_id, apiToken, cleanId);
    console.log(`[processOrderEvent] order state=${fullOrder.state} paymentState=${fullOrder.paymentState} total=${fullOrder.total}`);

    const isRefund = fullOrder.state === 'refunded' ||
                     fullOrder.paymentState === 'credited' ||
                     fullOrder.paymentState === 'PARTIALLY_REFUNDED' ||
                     (fullOrder.refundAmount || 0) > 0 ||
                     (fullOrder.refunds?.elements?.length > 0);

    const alreadyLogged = existingSales && existingSales.length > 0;
    if (!isRefund && alreadyLogged) { console.log('Sale already logged:', cleanId); return; }
    if (isRefund && existingSales && existingSales.some(r => r.type === 'Refund')) {
      console.log('Refund already logged:', cleanId); return;
    }

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
      const refundsData = await fetchOrderRefunds(store.merchant_id, apiToken, cleanId);
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

    // Use upsert + ignoreDuplicates against a unique (store_id, order_id, type)
    // constraint so two near-simultaneous webhook events for the same order
    // can't both pass the existingSales check above and double-insert/double-process.
    const { data: insertedRows, error: insertErr } = await supabase
      .from('sales_log')
      .upsert([{
        store_id: store.id, order_id: cleanId, type,
        gross: finalGross, net: finalNet, tax: finalTax,
        discounts: finalDiscounts, tips: finalTips,
        total_cost: totalCost, gross_profit: finalNet - totalCost,
        item_summary: itemSummary,
        status: isRefund ? (restockThisRefund ? 'Restocked' : 'Not Restocked') : 'OK'
      }], { onConflict: 'store_id,order_id,type', ignoreDuplicates: true })
      .select();

    if (insertErr) {
      console.error('sales_log insert error:', insertErr.message);
      return;
    }

    if (!insertedRows || insertedRows.length === 0) {
      console.log(`⏭️ Duplicate ${type} event ignored for order:`, cleanId);
      return;
    }

    console.log(`✅ Logged ${type} for store ${store.name}: $${finalNet.toFixed(2)}`);

    // Clover's itemStock can take a moment to reflect a sale's stock decrement,
    // so give it a brief head start before we re-fetch the item.
    if (!isRefund) await sleep(2000);

    for (const id of itemIds) {
      if (isRefund && restockThisRefund) {
        await pushStockToClover(store.merchant_id, apiToken, id, itemMap[id].qty);
      }
      await updateInventoryItem(store, id);
    }
  } catch (err) {
    console.error('processOrderEvent error:', err.message, err.response?.data);
  }
}

async function updateInventoryItem(store, itemId) {
  try {
    const apiToken = await getValidApiToken(store);
    const item = await fetchItem(store.merchant_id, apiToken, itemId);
    if (!item || item.hidden || item.deleted || !item.name) return;

    const cloverQty = item.itemStock ? item.itemStock.quantity : 0;
    const cost = item.cost ? (item.cost / 100) : 0;
    const price = item.price ? (item.price / 100) : 0;
    const category = item.categories?.elements?.[0]?.name || 'No Category';
    const groupName = item.itemGroup?.name || '';

    // --- Lead time: cheapest distributor for this item at this store ---
    let leadTime = 7; // default if no distributor prices exist
    try {
      const { data: distPrices } = await supabase
        .from('distributor_prices')
        .select('distributor_id, unit_cost')
        .eq('item_id', itemId)
        .eq('store_id', store.id)
        .gt('unit_cost', 0);

      if (distPrices && distPrices.length > 0) {
        const cheapest = distPrices.reduce((a, b) => a.unit_cost < b.unit_cost ? a : b);
        const { data: lt } = await supabase
          .from('distributor_lead_times')
          .select('lead_time_days')
          .eq('distributor_id', cheapest.distributor_id)
          .eq('store_id', store.id)
          .single();
        if (lt?.lead_time_days != null) leadTime = lt.lead_time_days;
      }
    } catch (_) {}

    // --- Buffer days + low stock threshold: per category setting ---
    let bufferDays = 3; // default
    let lowStockThreshold = 5; // default
    try {
      const { data: catSetting } = await supabase
        .from('category_settings')
        .select('buffer_days, low_stock_threshold')
        .eq('store_id', store.id)
        .eq('category', category)
        .single();
      if (catSetting?.buffer_days != null) bufferDays = catSetting.buffer_days;
      if (catSetting?.low_stock_threshold != null) lowStockThreshold = catSetting.low_stock_threshold;
    } catch (_) {}

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);

    const { data: salesRows } = await supabase
      .from('sales_log').select('item_summary, type')
      .eq('store_id', store.id).gte('created_at', cutoff.toISOString());

    let unitsSold = 0;
    (salesRows || []).forEach(row => {
      if (!row.item_summary || row.item_summary === 'N/A') return;
      row.item_summary.split(',').forEach(part => {
        const match = part.trim().match(/^([A-Za-z0-9]+)\s+x(\d+\.?\d*)/i);
        if (match && match[1] === itemId) {
          unitsSold += row.type === 'Refund' ? -(parseFloat(match[2]) || 1) : (parseFloat(match[2]) || 1);
        }
      });
    });

    const dailyRate = Math.max(0, unitsSold) / 14;
    // At or below low stock threshold: always suggest enough to cover lead + buffer (min 1)
    // Above threshold: order only the projected shortfall
    const suggested = cloverQty <= lowStockThreshold
      ? Math.max(1, Math.ceil(dailyRate * (leadTime + bufferDays)))
      : Math.max(0, Math.ceil(dailyRate * (leadTime + bufferDays) - cloverQty));

    // Check if item already exists - if so preserve existing metadata
const { data: existingItem } = await supabase
  .from('inventory_items')
  .select('category, group_name, variant_name, status, clover_qty')
  .eq('id', itemId)
  .single();

await supabase.from('inventory_items').upsert([{
  id: itemId,
  store_id: store.id,
  category: existingItem?.category || category,
  group_name: existingItem?.group_name !== undefined ? existingItem.group_name : groupName,
  variant_name: existingItem?.variant_name || item.name,
  cost,
  price,
  clover_qty: cloverQty,
  suggested_order: suggested > 0 ? suggested : 0,
  last_synced: new Date().toISOString()
}], { onConflict: 'id' });

    // Low stock alert — only notify when an Active item crosses into low/out of
    // stock (not on every sync), and skip items marked Dropping/On Hold/Not Tracking.
    const itemStatus = existingItem?.status || 'Active';
    if (itemStatus === 'Active') {
      const prevQty = existingItem?.clover_qty;
      const wasAboveThreshold = prevQty === undefined || prevQty === null || prevQty > lowStockThreshold;
      if (cloverQty <= lowStockThreshold && wasAboveThreshold) {
        const displayName = existingItem?.group_name || groupName || item.name;
        const displayCategory = existingItem?.category || category;
        await notify({
          type: 'low_stock',
          title: cloverQty <= 0 ? 'Item out of stock' : 'Low stock alert',
          message: cloverQty <= 0
            ? `${displayName} (${displayCategory}) at ${store.name} is out of stock.`
            : `${displayName} (${displayCategory}) at ${store.name} is low on stock — ${cloverQty} left.`,
          link: `/inventory?store=${store.id}`,
          store_id: store.id
        });
      }
    }

    console.log(`📦 Updated item ${itemId} for ${store.name}: qty=${cloverQty}`);
  } catch (err) {
    console.error('updateInventoryItem error:', err.message, err.response?.data);
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

    if (['gm', 'store_user'].includes(req.user.role) && req.user.store_id) {
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

    const toISODay = (ts) => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    };

    (current || []).forEach(row => {
      if (row.type === 'Refund') return;
      const day = toISODay(row.created_at);
      if (!dailyMap[day]) dailyMap[day] = 0;
      dailyMap[day] += row.net || 0;
    });

    (previous || []).forEach(row => {
      if (row.type === 'Refund') return;
      const day = toISODay(row.created_at);
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
    if (!isOwnerLevel(req.user.role)) return res.status(403).json({ error: 'Admin only' });

    const { start, end } = req.query;
    const startDate = new Date(start || new Date().setHours(0,0,0,0));
    const endDate = new Date(end || new Date().setHours(23,59,59,999));

    const { data: stores } = await supabase.from('stores').select('*').order('name');
    const { data: sales } = await supabase.from('sales_log').select('*')
      .gte('created_at', startDate.toISOString())
      .lte('created_at', endDate.toISOString());

    const storeMap = {};
    (stores || []).forEach(s => {
      storeMap[s.id] = { store_id: s.id, name: s.name, gross: 0, net: 0, tax: 0, discounts: 0, refunds: 0, tips: 0, totalCost: 0, orders: 0 };
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

// ─── Sales trends: week-over-week / month-over-month ─────────────────────────

router.get('/trends', auth, async (req, res) => {
  try {
    const { granularity = 'week', periods, store_id } = req.query;
    let storeId = store_id;
    if (['gm', 'store_user'].includes(req.user.role)) storeId = req.user.store_id;

    const numPeriods = Math.min(Math.max(parseInt(periods) || 8, 2), 26);
    const now = new Date();
    const ranges = [];

    if (granularity === 'month') {
      for (let i = numPeriods - 1; i >= 0; i--) {
        const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59, 999);
        ranges.push({ label: start.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }), start, end });
      }
    } else {
      const day = now.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      const thisMonday = new Date(now); thisMonday.setDate(now.getDate() + diff); thisMonday.setHours(0, 0, 0, 0);
      for (let i = numPeriods - 1; i >= 0; i--) {
        const start = new Date(thisMonday); start.setDate(start.getDate() - i * 7);
        const end = new Date(start); end.setDate(end.getDate() + 6); end.setHours(23, 59, 59, 999);
        ranges.push({ label: start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), start, end });
      }
    }

    let query = supabase.from('sales_log').select('created_at, net, total_cost, type')
      .gte('created_at', ranges[0].start.toISOString())
      .lte('created_at', ranges[ranges.length - 1].end.toISOString());
    if (storeId) query = query.eq('store_id', storeId);

    const { data: rows } = await query;

    const result = ranges.map(r => {
      let net = 0, cost = 0, orders = 0, refunds = 0;
      (rows || []).forEach(row => {
        const d = new Date(row.created_at);
        if (d >= r.start && d <= r.end) {
          if (row.type === 'Refund') {
            net += row.net || 0;
            refunds += Math.abs(row.net || 0);
          } else {
            net += row.net || 0;
            cost += row.total_cost || 0;
            orders++;
          }
        }
      });
      return {
        label: r.label,
        net: Math.round(net * 100) / 100,
        grossProfit: Math.round((net - cost) * 100) / 100,
        orders,
        refunds: Math.round(refunds * 100) / 100
      };
    });

    res.json({ granularity, periods: result });
  } catch (err) {
    console.error('Sales trends error:', err);
    res.status(500).json({ error: 'Failed to load sales trends' });
  }
});

// ─── Item performance: top/lowest selling item groups per category ──────────

router.get('/item-performance', auth, async (req, res) => {
  try {
    const { start, end, store_id } = req.query;
    let storeId = store_id;
    if (['gm', 'store_user'].includes(req.user.role)) storeId = req.user.store_id;
    if (!storeId) return res.status(400).json({ error: 'store_id required' });

    const startDate = new Date(start || new Date().setHours(0,0,0,0));
    const endDate = new Date(end || new Date().setHours(23,59,59,999));

    const { data: sales } = await supabase.from('sales_log')
      .select('item_summary, type')
      .eq('store_id', storeId)
      .gte('created_at', startDate.toISOString())
      .lte('created_at', endDate.toISOString());

    const unitsSold = {}; // itemId -> qty (refunds subtract)
    (sales || []).forEach(row => {
      if (!row.item_summary || row.item_summary === 'N/A') return;
      row.item_summary.split(',').forEach(part => {
        const m = part.trim().match(/^([A-Za-z0-9]+)\s+x(\d+\.?\d*)/i);
        if (m) {
          const qty = parseFloat(m[2]) || 0;
          unitsSold[m[1]] = (unitsSold[m[1]] || 0) + (row.type === 'Refund' ? -qty : qty);
        }
      });
    });

    const { data: items } = await supabase.from('inventory_items')
      .select('id, category, group_name, variant_name, price, status')
      .eq('store_id', storeId);

    // Aggregate by category -> item group (group_name, falling back to variant/item name)
    const groups = {};
    (items || []).forEach(item => {
      const category = item.category || 'No Category';
      const name = item.group_name || item.variant_name || item.id;
      const key = category + '|||' + name;
      const units = Math.max(0, unitsSold[item.id] || 0);
      const revenue = units * (item.price || 0);
      if (!groups[key]) groups[key] = { category, name, units: 0, revenue: 0 };
      groups[key].units += units;
      groups[key].revenue += revenue;
    });

    const byCategory = {};
    Object.values(groups).forEach(g => {
      if (!byCategory[g.category]) byCategory[g.category] = [];
      byCategory[g.category].push(g);
    });

    const result = Object.keys(byCategory).sort().map(category => {
      const list = byCategory[category];
      const sorted = [...list].sort((a, b) => b.units - a.units);
      const top = sorted.slice(0, 5);
      const bottom = sorted.slice(-5).reverse().filter(g => !top.includes(g));
      return { category, top, bottom };
    }).filter(c => c.top.length > 0);

    res.json({ categories: result });
  } catch (err) {
    console.error('Item performance error:', err);
    res.status(500).json({ error: 'Failed to load item performance' });
  }
});

module.exports = router;