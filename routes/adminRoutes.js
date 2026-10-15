const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const rcController = require('../controllers/rcController');
const gstController = require('../controllers/gstController');
const ticketController = require('../controllers/ticketController');
const auth = require('../middleware/auth');
const isAdmin = require('../middleware/adminMiddleware');

router.get('/overview/summary', auth, isAdmin, adminController.getOverviewSummary);
router.get('/overview/money-timeseries', auth, isAdmin, adminController.getMoneyTimeseries);
router.get('/overview/bureau-split', auth, isAdmin, adminController.getBureauSplit);
router.get('/overview/top-partners', auth, isAdmin, adminController.getTopPartners);
router.get('/overview/recent-activity', auth, isAdmin, adminController.getRecentActivity);
router.get('/reports/ai-analyzer', auth, isAdmin, adminController.getAllAiAnalyses);
router.get('/reports/credit-reports', auth, isAdmin, adminController.getAllCreditReports);
router.get('/reports/failed-reports', auth, isAdmin, adminController.getFailedCreditReports);
router.get('/rc-reports', auth, isAdmin, rcController.getAllRcVerifications);
router.get('/gst-reports', auth, isAdmin, gstController.getAllGstVerifications);
router.get('/partners', auth, isAdmin, adminController.getAllPartners);
router.patch('/partners/:id/status', auth, isAdmin, adminController.setPartnerStatus);
router.post('/partners/:id/add-funds', auth, isAdmin, adminController.addFundsToPartner);
router.post('/partners/:id/deduct-funds', auth, isAdmin, adminController.deductFundsFromPartner);
router.get('/partners/:id', auth, isAdmin, adminController.getPartnerById);
router.patch('/partners/:id', auth, isAdmin, adminController.updatePartner);
router.get('/partners/:id/reports', auth, isAdmin, adminController.getPartnerReports);
router.get('/partners/:id/transactions', auth, isAdmin, adminController.getPartnerTransactions);
router.get('/transactions', auth, isAdmin, adminController.getAllTransactions);
router.get('/pricing', auth, isAdmin, adminController.getPricing);
router.patch('/pricing', auth, isAdmin, adminController.updatePricing);

// Google Sheets export (Admin → Settings)
const sheetsController = require('../controllers/sheetsController');
router.get('/integrations/google-sheets', auth, isAdmin, sheetsController.getSheetsSettings);
router.put('/integrations/google-sheets', auth, isAdmin, sheetsController.updateSheetsSettings);
router.post('/integrations/google-sheets/sync-now', auth, isAdmin, sheetsController.triggerSheetsSync);

// Add Funds banner (Admin → Banners tab). Upload uses its own multer config
// (image-only); multer errors surface as 400 with the reason.
const bannerController = require('../controllers/bannerController');
const { bannerUpload } = require('../config/bannerUpload');
router.get('/banners/add-funds', auth, isAdmin, bannerController.getAddFundsBanner);
router.post('/banners/add-funds', auth, isAdmin, (req, res, next) => {
  bannerUpload.single('banner')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    next();
  });
}, bannerController.uploadAddFundsBanner);
router.patch('/banners/add-funds', auth, isAdmin, bannerController.setAddFundsBannerEnabled);
router.delete('/banners/add-funds', auth, isAdmin, bannerController.resetAddFundsBanner);

// Support Ticket routes
router.get('/tickets/unread-count', auth, isAdmin, ticketController.getUnreadCount);
router.post('/tickets/mark-seen', auth, isAdmin, ticketController.markTicketsSeen);
router.get('/tickets', auth, isAdmin, ticketController.getAllTickets);
router.get('/tickets/:id', auth, isAdmin, ticketController.getTicketById);
router.patch('/tickets/:id', auth, isAdmin, ticketController.updateTicket);
router.post('/tickets/:id/messages', auth, isAdmin, ticketController.addMessage);

module.exports = router;
