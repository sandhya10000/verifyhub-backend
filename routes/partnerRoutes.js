const express = require('express');
const router = express.Router();
const partnerController = require('../controllers/partnerController');
const auth = require('../middleware/auth');

router.get('/overview/summary', auth, partnerController.getSummary);
router.get('/overview/timeseries', auth, partnerController.getTimeseries);
router.get('/overview/recent', auth, partnerController.getRecent);
router.get('/profile', auth, partnerController.getProfile);
router.get('/transactions', auth, partnerController.getMyTransactions);

// Public price list for the Plans page (no auth — prices aren't secret).
// Computed totals only, so the frontend never does money math.
router.get('/pricing/plans', partnerController.getPublicPlans);

module.exports = router;
