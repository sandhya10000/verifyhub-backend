const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const ticketController = require('../controllers/ticketController');
const auth = require('../middleware/auth');
const isAdmin = require('../middleware/adminMiddleware');

router.get('/overview/summary', auth, isAdmin, adminController.getOverviewSummary);
router.get('/reports/ai-analyzer', auth, isAdmin, adminController.getAllAiAnalyses);
router.get('/reports/credit-reports', auth, isAdmin, adminController.getAllCreditReports);
router.get('/partners', auth, isAdmin, adminController.getAllPartners);

// Support Ticket routes
router.get('/tickets/unread-count', auth, isAdmin, ticketController.getUnreadCount);
router.post('/tickets/mark-seen', auth, isAdmin, ticketController.markTicketsSeen);
router.get('/tickets', auth, isAdmin, ticketController.getAllTickets);
router.get('/tickets/:id', auth, isAdmin, ticketController.getTicketById);
router.patch('/tickets/:id', auth, isAdmin, ticketController.updateTicket);

module.exports = router;
