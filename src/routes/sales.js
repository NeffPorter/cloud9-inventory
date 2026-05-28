const express = require('express');
const router = express.Router();

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

module.exports = router;