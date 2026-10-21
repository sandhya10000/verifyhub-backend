const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  createRequest,
  getRequest,
  getBrandingStatus,
  getQuote,
  payWithWallet,
  createOrder,
  verifyPayment,
  cancelCustomBrandedOrder,
  submitBrandAssets,
  requestRevision,
  uploadBrandedReport,
  getActiveBrandProfile,
} = require('../controllers/customBrandedReportController');
const { upload } = require('../config/uploadConfig');

// GET  /api/partner/custom-branded-report/profile  — fetch active brand profile (firmName, tagline, logo)
router.get('/profile', auth, getActiveBrandProfile);

// POST /api/partner/custom-branded-report/analyze  — upload and analyze credit report with partner branding
router.post('/analyze', auth, upload.single('file'), uploadBrandedReport);

// GET  /api/partner/custom-branded-report/status   — fetch user branding status & onboarding details
router.get('/status', auth, getBrandingStatus);

// GET  /api/partner/custom-branded-report          — fetch current request status (compatible with both)
router.get('/', auth, getRequest);

// GET  /api/partner/custom-branded-report/quote    — one-time fee + wallet balance
router.get('/quote', auth, getQuote);

// POST /api/partner/custom-branded-report/pay/wallet — pay ₹2500 via wallet
router.post('/pay/wallet', auth, payWithWallet);

// POST /api/partner/custom-branded-report/order    — create Razorpay order
router.post('/order', auth, createOrder);

// POST /api/partner/custom-branded-report/verify  — verify Razorpay payment
router.post('/verify', auth, verifyPayment);

// POST /api/partner/custom-branded-report/cancel  — mark attempt failed (+WhatsApp retry link)
router.post('/cancel', auth, cancelCustomBrandedOrder);

// POST /api/partner/custom-branded-report/assets  — submit brand assets (logo, colors, details)
router.post('/assets', auth, submitBrandAssets);

// POST /api/partner/custom-branded-report/request-revision — request design revision
router.post('/request-revision', auth, requestRevision);

// POST /api/partner/custom-branded-report          — legacy free submit (closed, 402)
router.post('/', auth, createRequest);

module.exports = router;
