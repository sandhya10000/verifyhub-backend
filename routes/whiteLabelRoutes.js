const express = require('express');
const multer = require('multer');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const {
  listRequests,
  exportRequestsCsv,
  getRequestDetail,
  saveBrandProfile,
  updateSetupStatus,
} = require('../controllers/whiteLabelController');

const router = express.Router();

// Brand designer panel + admin tracking. Both roles share these endpoints.
const staffOnly = [auth, requireRole('admin', 'brand_designer')];

// Logo kept in memory: the controller builds the data URI and writes brand-assets/.
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

// Order matters: /export must be registered before /:id
router.get('/export', ...staffOnly, exportRequestsCsv);
router.get('/', ...staffOnly, listRequests);
router.get('/:id', ...staffOnly, getRequestDetail);
router.put('/:id/profile', ...staffOnly, logoUpload.single('logo'), saveBrandProfile);
router.put('/:id/status', ...staffOnly, updateSetupStatus);

module.exports = router;
