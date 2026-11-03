const express = require('express');
const auth = require('../middleware/auth');
const { uploadBankStatement } = require('../config/bsaUploadConfig');
const bsaController = require('../controllers/bsaController');

const router = express.Router();

// Multer errors (wrong type, too large) come back as a clean 400.
const withUpload = (req, res, next) => {
  uploadBankStatement.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message || 'Upload failed.' });
    }
    next();
  });
};

// POST /api/bsa/analyze
router.post('/analyze', auth, withUpload, bsaController.analyze);
// GET /api/bsa/my-analyses
router.get('/my-analyses', auth, bsaController.getMyAnalyses);
// GET /api/bsa/:id/report  (declared before /:id so it is not swallowed)
router.get('/:id/report', auth, bsaController.downloadReport);
// GET /api/bsa/:id
router.get('/:id', auth, bsaController.getStatus);

module.exports = router;
