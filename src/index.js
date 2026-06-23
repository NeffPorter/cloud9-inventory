const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const cron = require('node-cron');

dotenv.config();

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
app.use('/api/owner', require('./routes/owner'));

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

module.exports = app;