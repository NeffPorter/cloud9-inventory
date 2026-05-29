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
      const itemId = (rl.item?.id || rl.id || '').toString().trim();
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

module.exports = {
  cloverFetch,
  fetchFullOrder,
  fetchOrderRefunds,
  fetchItem,
  pushStockToClover,
  extractLineItems,
  extractRefundedItems
};