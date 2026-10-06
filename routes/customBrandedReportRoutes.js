const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  createRequest,
  getRequest,
} = require('../controllers/customBrandedReportController');

// GET  /api/partner/custom-branded-report  — fetch current request status
router.get('/', auth, getRequest);

// POST /api/partner/custom-branded-report  — submit a new request
router.post('/', auth, createRequest);

module.exports = router;
