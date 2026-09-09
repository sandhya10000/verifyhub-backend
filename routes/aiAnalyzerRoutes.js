const express = require('express');
const router = express.Router();

const { upload } = require('../config/uploadConfig');
const {
  uploadReport,
  getAnalysis,
  downloadPdf,
  listAnalyses,
  getReportStats,
} = require('../controllers/aiAnalyzerController');

const auth = require('../middleware/auth');

router.post('/upload', auth, upload.single('file'), uploadReport);
// /stats MUST be registered before /:id so Express doesn't treat 'stats' as a param value
router.get('/stats', auth, getReportStats);
router.get('/:id', auth, getAnalysis);
router.get('/:id/download-pdf', auth, downloadPdf);
router.get('/', auth, listAnalyses);

module.exports = router;
