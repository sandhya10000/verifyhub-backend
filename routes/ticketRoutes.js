const express = require('express');
const router = express.Router();
const ticketController = require('../controllers/ticketController');
const auth = require('../middleware/auth');

// Partner routes
router.post('/', auth, ticketController.createTicket);
router.get('/', auth, ticketController.getMyTickets);
// Static paths must come before '/:id' or Express treats them as ticket IDs.
router.get('/unread-count', auth, ticketController.getPartnerUnreadCount);
router.post('/mark-seen', auth, ticketController.markTicketsSeen);
router.get('/:id', auth, ticketController.getMyTicketById);
router.post('/:id/messages', auth, ticketController.addMessage);

module.exports = router;
