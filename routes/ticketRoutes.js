const express = require('express');
const router = express.Router();
const ticketController = require('../controllers/ticketController');
const auth = require('../middleware/auth');

// Partner routes
router.post('/', auth, ticketController.createTicket);
router.get('/', auth, ticketController.getMyTickets);
router.get('/:id', auth, ticketController.getMyTicketById);
router.post('/:id/messages', auth, ticketController.addMessage);

module.exports = router;
