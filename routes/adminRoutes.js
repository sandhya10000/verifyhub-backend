const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const ticketController = require('../controllers/ticketController');
const auth = require('../middleware/auth');
const isAdmin = require('../middleware/adminMiddleware');

router.get('/overview/summary', auth, isAdmin, adminController.getOverviewSummary);
router.get('/overview/money-timeseries', auth, isAdmin, adminController.getMoneyTimeseries);
router.get('/overview/plan-distribution', auth, isAdmin, adminController.getPlanDistribution);
router.get('/overview/bureau-split', auth, isAdmin, adminController.getBureauSplit);
router.get('/overview/score-mix', auth, isAdmin, adminController.getScoreMix);
router.get('/overview/top-partners', auth, isAdmin, adminController.getTopPartners);
router.get('/overview/recent-activity', auth, isAdmin, adminController.getRecentActivity);
router.get('/reports/ai-analyzer', auth, isAdmin, adminController.getAllAiAnalyses);
router.get('/reports/credit-reports', auth, isAdmin, adminController.getAllCreditReports);
router.get('/partners', auth, isAdmin, adminController.getAllPartners);
router.get('/transactions', auth, isAdmin, adminController.getAllTransactions);
router.get('/pricing', auth, isAdmin, adminController.getPricing);
router.patch('/pricing', auth, isAdmin, adminController.updatePricing);

// Support Ticket routes
router.get('/tickets/unread-count', auth, isAdmin, ticketController.getUnreadCount);
router.post('/tickets/mark-seen', auth, isAdmin, ticketController.markTicketsSeen);
router.get('/tickets', auth, isAdmin, ticketController.getAllTickets);
router.get('/tickets/:id', auth, isAdmin, ticketController.getTicketById);
router.patch('/tickets/:id', auth, isAdmin, ticketController.updateTicket);
router.post('/tickets/:id/messages', auth, isAdmin, ticketController.addMessage);

module.exports = router;
