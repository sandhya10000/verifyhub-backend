const express = require('express');
const router = express.Router();
const ticketController = require('../controllers/ticketController');
const auth = require('../middleware/auth');
const { attachImages } = require('../config/ticketUpload');

// Partner routes
router.post('/', auth, attachImages, ticketController.createTicket);
router.get('/', auth, ticketController.getMyTickets);
// Static paths must come before '/:id' or Express treats them as ticket IDs.
router.get('/unread-count', auth, ticketController.getPartnerUnreadCount);
router.post('/mark-seen', auth, ticketController.markTicketsSeen);
router.get('/:id', auth, ticketController.getMyTicketById);
router.post('/:id/messages', auth, attachImages, ticketController.addMessage);

module.exports = router;
