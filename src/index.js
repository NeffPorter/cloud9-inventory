const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/pos', require('./routes/pos'));
app.use('/api/sales', require('./routes/sales'));

// Health check
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = app;