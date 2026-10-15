const express = require('express');
const router = express.Router();

const { upload } = require('../config/uploadConfig');
const {
  uploadReport,
  getAnalysis,
  downloadPdf,
  downloadSharedPdf,
  downloadUpload,
  listAnalyses,
  getReportStats,
} = require('../controllers/aiAnalyzerController');

const auth = require('../middleware/auth');
// TODO(multi-plan-restore): re-add requirePlanChosen to the upload route below.
// const requirePlanChosen = require('../middleware/requirePlanChosen');

router.post('/upload', auth, upload.single('file'), uploadReport);
// Public signed share links (Google Sheets "Report Link" column) — no login.
// Two-segment path, so it never collides with the single-segment /:id routes.
router.get('/shared/:id', downloadSharedPdf);
// /stats MUST be registered before /:id so Express doesn't treat 'stats' as a param value
router.get('/stats', auth, getReportStats);
router.get('/:id', auth, getAnalysis);
router.get('/:id/download-pdf', auth, downloadPdf);
router.get('/:id/upload', auth, downloadUpload);
router.get('/', auth, listAnalyses);

module.exports = router;
