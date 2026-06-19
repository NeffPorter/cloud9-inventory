const axios = require('axios');

const CLOVER_BASE = 'https://api.clover.com/v3/merchants/';

async function cloverFetch(endpoint, merchantId, apiToken) {
  const url = `${CLOVER_BASE}${merchantId}/${endpoint}`;
  const response = await axios.get(url, {
    headers: { 'Authorization': 'Bearer ' + apiToken }
  });
  return response.data;
}

async function fetchFullOrder(merchantId, apiToken, orderId) {
  const cleanId = orderId.replace(/^O:/, '');
  return cloverFetch(
    `orders/${cleanId}?expand=lineItems,lineItems.elements,lineItems.elements.refunds,refunds,credits,payments`,
    merchantId, apiToken
  );
}

async function fetchOrderRefunds(merchantId, apiToken, orderId) {
  const cleanId = orderId.replace(/^O:/, '');
  return cloverFetch(`orders/${cleanId}/refunds?expand=lineItems`, merchantId, apiToken);
}

async function fetchItem(merchantId, apiToken, itemId) {
  return cloverFetch(`items/${itemId}?expand=itemStock,categories,itemGroup`, merchantId, apiToken);
}

async function pushStockToClover(merchantId, apiToken, itemId, qtyToAdd) {
  try {
    const item = await cloverFetch(`items/${itemId}?expand=itemStock`, merchantId, apiToken);
    const currentQty = item.itemStock ? item.itemStock.quantity : 0;
    const newQty = currentQty + qtyToAdd;
    const url = `${CLOVER_BASE}${merchantId}/item_stocks/${itemId}`;
    await axios.post(url, { quantity: newQty }, {
      headers: {
        'Authorization': 'Bearer ' + apiToken,
        'Content-Type': 'application/json'
      }
    });
    return true;
  } catch (err) {
    console.error('pushStockToClover error:', err.message);
    return false;
  }
}
async function setStockInClover(merchantId, apiToken, itemId, quantity) {
  try {
    const url = `${CLOVER_BASE}${merchantId}/item_stocks/${itemId}`;
    await axios.post(url, { quantity }, {
      headers: {
        'Authorization': 'Bearer ' + apiToken,
        'Content-Type': 'application/json'
      }
    });
    return true;
  } catch (err) {
    console.error('setStockInClover error:', err.message);
    return false;
  }
}
async function updateItemPriceAndCost(merchantId, apiToken, itemId, price, cost) {
  try {
    const url = `${CLOVER_BASE}${merchantId}/items/${itemId}`;
    await axios.post(url, {
      price: Math.round(price * 100),
      cost: Math.round(cost * 100)
    }, {
      headers: {
        'Authorization': 'Bearer ' + apiToken,
        'Content-Type': 'application/json'
      }
    });
    return true;
  } catch (err) {
    console.error('updateItemPriceAndCost error:', err.message);
    return false;
  }
}

function extractLineItems(fullOrder) {
  const itemMap = {};
  (fullOrder.lineItems?.elements || []).forEach(li => {
    if (li.refunded === true) return;
    const itemId = (li.item?.id || '').toString().trim();
    if (!itemId || itemId.length < 8) return;
    const qty = li.unitQty ? (li.unitQty / 1000) : (li.quantity || 1);
    if (!itemMap[itemId]) itemMap[itemId] = { qty: 0 };
    itemMap[itemId].qty += qty;
  });
  return itemMap;
}

function extractRefundedItems(fullOrder) {
  const itemMap = {};
  const lineItems = fullOrder.lineItems?.elements || [];

  lineItems.forEach(li => {
    const isRefunded = li.refunded === true ||
                       (li.refunds?.elements?.length > 0) ||
                       (li.refundedQuantity && li.refundedQuantity > 0);
    if (!isRefunded) return;
    const itemId = (li.item?.id || '').toString().trim();
    if (!itemId || itemId.length < 8) return;
    const qty = li.refundedQuantity
      ? li.refundedQuantity
      : (li.unitQty ? (li.unitQty / 1000) : (li.quantity || 1));
    if (!itemMap[itemId]) itemMap[itemId] = { qty: 0 };
    itemMap[itemId].qty += qty;
  });

  (fullOrder.refunds?.elements || []).forEach(refund => {
    (refund.lineItems?.elements || []).forEach(rl => {
      const itemId = (rl.item?.id || '').toString().trim();
      if (!itemId || itemId.length < 8) return;
      const qty = rl.unitQty ? (rl.unitQty / 1000) : (rl.quantity || 1);
      if (!itemMap[itemId]) itemMap[itemId] = { qty: 0 };
      itemMap[itemId].qty += qty;
    });
  });

  if (Object.keys(itemMap).length === 0 &&
      (fullOrder.state === 'refunded' || fullOrder.paymentState === 'credited')) {
    lineItems.forEach(li => {
      const itemId = (li.item?.id || '').toString().trim();
      if (!itemId || itemId.length < 8) return;
      const qty = li.unitQty ? (li.unitQty / 1000) : (li.quantity || 1);
      if (!itemMap[itemId]) itemMap[itemId] = { qty: 0 };
      itemMap[itemId].qty += qty;
    });
  }

  return itemMap;
}

// Create a real order + cash-tender payment on Clover for the given line items.
// lineItems: [{ id: cloverItemId, name, price (cents) }]
// Uses Clover's documented "create a payment record" endpoint with the merchant's Cash
// tender — this is a bookkeeping entry like a register logging a cash sale, no real money moves.
// Returns the created orderId so callers can track/report on it.
async function createCashSale(merchantId, apiToken, lineItems, cachedCashTenderId = null) {
  const headers = { Authorization: 'Bearer ' + apiToken, 'Content-Type': 'application/json' };
  const base = `${CLOVER_BASE}${merchantId}`;

  const orderRes = await axios.post(`${base}/orders`, { state: 'open' }, { headers });
  const orderId = orderRes.data.id;

  await axios.post(`${base}/orders/${orderId}/bulk_line_items`, {
    items: lineItems.map(i => ({ item: { id: i.id }, price: i.price, name: i.name }))
  }, { headers });

  let cashTenderId = cachedCashTenderId;
  if (!cashTenderId) {
    const tendersRes = await axios.get(`${base}/tenders`, { headers });
    const cashTender = (tendersRes.data.elements || []).find(t => t.labelKey === 'com.clover.tender.cash')
      || (tendersRes.data.elements || [])[0];
    if (!cashTender) throw new Error('No tender found on this merchant — cannot record a payment');
    cashTenderId = cashTender.id;
  }

  const total = lineItems.reduce((sum, i) => sum + i.price, 0);
  await axios.post(`${base}/orders/${orderId}/payments`, {
    order: { id: orderId },
    tender: { id: cashTenderId },
    amount: total,
    result: 'SUCCESS'
  }, { headers });

  return { orderId, total, cashTenderId };
}

async function getCashTenderId(merchantId, apiToken) {
  const headers = { Authorization: 'Bearer ' + apiToken, 'Content-Type': 'application/json' };
  const tendersRes = await axios.get(`${CLOVER_BASE}${merchantId}/tenders`, { headers });
  const cashTender = (tendersRes.data.elements || []).find(t => t.labelKey === 'com.clover.tender.cash')
    || (tendersRes.data.elements || [])[0];
  return cashTender?.id || null;
}

module.exports = {
  cloverFetch,
  fetchFullOrder,
  fetchOrderRefunds,
  fetchItem,
  pushStockToClover,
  setStockInClover,
  updateItemPriceAndCost,
  extractLineItems,
  extractRefundedItems,
  createCashSale,
  getCashTenderId
};