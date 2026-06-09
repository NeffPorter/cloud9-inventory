const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// API Routes FIRST
app.use('/api/auth', require('./routes/auth'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/pos', require('./routes/pos'));
app.use('/api/sales', require('./routes/sales'));

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

module.exports = app;