const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  createRequest,
  getRequest,
  getQuote,
  payWithWallet,
  createOrder,
  verifyPayment,
} = require('../controllers/customBrandedReportController');

// GET  /api/partner/custom-branded-report          — fetch current request status
router.get('/', auth, getRequest);

// GET  /api/partner/custom-branded-report/quote    — one-time fee + wallet balance
router.get('/quote', auth, getQuote);

// POST /api/partner/custom-branded-report/pay/wallet — pay ₹2500 via wallet
router.post('/pay/wallet', auth, payWithWallet);

// POST /api/partner/custom-branded-report/order    — create Razorpay order
router.post('/order', auth, createOrder);

// POST /api/partner/custom-branded-report/verify  — verify Razorpay payment
router.post('/verify', auth, verifyPayment);

// POST /api/partner/custom-branded-report          — legacy free submit (closed, 402)
router.post('/', auth, createRequest);

module.exports = router;
