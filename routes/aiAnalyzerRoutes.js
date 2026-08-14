const express = require('express');
const router = express.Router();

const { upload } = require('../config/uploadConfig');
const {
  uploadReport,
  getAnalysis,
  downloadPdf,
  listAnalyses,
} = require('../controllers/aiAnalyzerController');

const auth = require('../middleware/auth');

router.post('/upload', auth, upload.single('file'), uploadReport);
router.get('/:id', auth, getAnalysis);
router.get('/:id/download-pdf', auth, downloadPdf);
router.get('/', auth, listAnalyses);

module.exports = router;
