const express = require('express');
const router = express.Router();
const partnerController = require('../controllers/partnerController');
const auth = require('../middleware/auth');

router.get('/overview/summary', auth, partnerController.getSummary);
router.get('/overview/timeseries', auth, partnerController.getTimeseries);
router.get('/overview/score-mix', auth, partnerController.getScoreMix);
router.get('/overview/recent', auth, partnerController.getRecent);

module.exports = router;
