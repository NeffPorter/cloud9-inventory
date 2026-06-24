const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const cron = require('node-cron');

dotenv.config();

console.log('[Startup] GMAIL_USER:', process.env.GMAIL_USER || 'MISSING');
console.log('[Startup] GMAIL_PASS:', process.env.GMAIL_PASS ? '***set***' : 'MISSING');
console.log('[Startup] All env keys:', Object.keys(process.env).join(', '));

const app = express();
app.use(cors());
app.use(express.json());

// API Routes FIRST
app.use('/api/auth', require('./routes/auth'));
const inventoryRouter = require('./routes/inventory');
app.use('/api/inventory', inventoryRouter);
app.use('/api/pos', require('./routes/pos'));
app.use('/api/distributors', require('./routes/distributors'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/budgets', require('./routes/budgets'));
app.use('/api/notifications', require('./routes/notifications'));
const schedulesRouter = require('./routes/schedules');
app.use('/api/schedules', schedulesRouter);
const saleEventsRouter = require('./routes/sale-events');
app.use('/api/sale-events', saleEventsRouter);
const storeTasksRouter = require('./routes/store-tasks');
app.use('/api/store-tasks', storeTasksRouter);
app.use('/api/store-expenses', require('./routes/store-expenses'));
const ownerRouter = require('./routes/owner');
app.use('/api/owner', ownerRouter);

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// Page routes
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});
app.get('/stores', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/stores.html'));
});
app.get('/users', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/users.html'));
});
app.get('/sales', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/sales.html'));
});
app.get('/inventory', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/inventory.html'));
});
app.get('/install', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/install.html'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});
app.get('/stocktake', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/stocktake.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Discount schedule cron (ad-hoc) — daily at midnight
cron.schedule('0 0 * * *', () => {
  schedulesRouter.runCron().catch(err => console.error('Discount cron error:', err.message));
});
schedulesRouter.runCron().catch(err => console.error('Discount cron startup error:', err.message));

// Sale events cron — daily at 1am (apply/remove Clover discounts on start/end date)
cron.schedule('0 1 * * *', () => {
  saleEventsRouter.runSaleEventCron().catch(err => console.error('Sale events cron error:', err.message));
});
saleEventsRouter.runSaleEventCron().catch(err => console.error('Sale events cron startup error:', err.message));

// Stocktake task cron — 1st of every month at 6am
cron.schedule('0 6 1 * *', () => {
  storeTasksRouter.runStocktakeCron().catch(err => console.error('Stocktake cron error:', err.message));
});

// Nightly inventory sync — 3am daily (catches any missed webhook updates)
cron.schedule('0 3 * * *', async () => {
  try {
    const supabase = require('./lib/supabase');
    const { data: stores } = await supabase.from('stores').select('*').not('merchant_id', 'is', null);
    if (!stores?.length) return;
    console.log(`🌙 Nightly inventory sync — ${stores.length} store(s)`);
    const { triggerBackgroundSync } = inventoryRouter;
    for (const store of stores) {
      try {
        await triggerBackgroundSync(store);
      } catch (err) {
        console.error(`Nightly sync failed for store ${store.name}:`, err.message);
      }
    }
    console.log('✅ Nightly inventory sync complete');
  } catch (err) {
    console.error('Nightly inventory sync error:', err.message);
  }
});

// P&L auto-snapshot — last day of every month at 11:55pm
cron.schedule('55 23 28-31 * *', async () => {
  const now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (tomorrow.getDate() !== 1) return; // only fires on the actual last day of month
  const y = now.getFullYear(), m = now.getMonth() + 1;
  const pad = n => String(n).padStart(2, '0');
  const lastDay = new Date(y, m, 0).getDate();
  const label = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  await ownerRouter.autoSnapshotPL('monthly', `${y}-${pad(m)}-01`, `${y}-${pad(m)}-${lastDay}`, label);
});

// P&L auto-snapshot — last day of every quarter at 11:56pm
cron.schedule('56 23 28-31 3,6,9,12 *', async () => {
  const now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (tomorrow.getDate() !== 1) return;
  const y = now.getFullYear(), m = now.getMonth() + 1;
  if (![3, 6, 9, 12].includes(m)) return;
  const q = Math.ceil(m / 3);
  const qStart = (q - 1) * 3 + 1;
  const qEnd = q * 3;
  const lastDay = new Date(y, qEnd, 0).getDate();
  const pad = n => String(n).padStart(2, '0');
  await ownerRouter.autoSnapshotPL('quarterly', `${y}-${pad(qStart)}-01`, `${y}-${pad(qEnd)}-${lastDay}`, `Q${q} ${y}`);
});
app.get('/stocktake/new', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/stocktake-new.html'));
});
app.get('/stocktake/report', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/stocktake-report.html'));
});
app.get('/pos', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/pos.html'));
});
app.get('/pos/new', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/pos-new.html'));
});
app.get('/pos/view', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/pos-view.html'));
});
app.get('/distributors', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/distributors.html'));
});
app.get('/distributor-prices', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/distributor-prices.html'));
});
app.get('/suggested', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/suggested.html'));
});
app.get('/budgets', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/budgets.html'));
});
app.get('/budget-view', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/budget-view.html'));
});
app.get('/activity-log', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/activity-log.html'));
});
app.get('/schedules', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/schedules.html'));
});
app.get('/sale-events', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/sale-events.html'));
});
app.get('/sale-proposal', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/sale-proposal.html'));
});
app.get('/store-tasks', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/store-tasks.html'));
});
app.get('/gm-expenses', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/gm-expenses.html'));
});
app.get('/owner-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/owner-dashboard.html'));
});
app.get('/owner-inventory', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/owner-inventory.html'));
});
app.get('/owner-pl', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/owner-pl.html'));
});
app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/settings.html'));
});

module.exports = app;