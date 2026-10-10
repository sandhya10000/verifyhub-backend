const Ticket = require('../models/Ticket');
const User = require('../models/User');
const { sendTicketResolvedMail } = require('../utils/sendMail');

// ==========================================
// PARTNER CONTROLLERS
// ==========================================

exports.createTicket = async (req, res) => {
  try {
    const { category, reference, description } = req.body;

    if (!category || !description) {
      return res.status(400).json({ success: false, message: 'Category and description are required' });
    }

    // Support ID: random six-digit number, unique across tickets.
    // Frontend sends a pre-generated one; fall back to server-side
    // generation (with retries) so direct API calls are covered too.
    const makeSupportId = () => String(Math.floor(100000 + Math.random() * 900000));
    let supportId = String(reference || '').trim() || makeSupportId();
    for (let i = 0; i < 5 && await Ticket.exists({ reference: supportId }); i++) {
      supportId = makeSupportId();
    }

    const newTicket = await Ticket.create({
      partnerId: req.user._id, // Assuming authMiddleware sets req.user
      category,
      reference: supportId,
      description
    });

    res.status(201).json({ success: true, data: newTicket, message: 'Ticket created successfully' });
  } catch (error) {
    console.error('createTicket Error:', error);
    res.status(500).json({ success: false, message: 'Failed to create ticket' });
  }
};

exports.getMyTickets = async (req, res) => {
  try {
    const tickets = await Ticket.find({ partnerId: req.user._id })
      .populate('messages.sender', 'name role')
      .sort({ updatedAt: -1 });

    res.json({ success: true, data: tickets });
  } catch (error) {
    console.error('getMyTickets Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch tickets' });
  }
};

exports.getMyTicketById = async (req, res) => {
  try {
    const ticket = await Ticket.findOne({ _id: req.params.id, partnerId: req.user._id })
      .populate('messages.sender', 'name role');

    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    res.json({ success: true, data: ticket });
  } catch (error) {
    console.error('getMyTicketById Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch ticket' });
  }
};

// Count unseen ADMIN replies across this partner's own tickets — messages with
// senderRole 'admin' created after the partner last viewed the Support page.
// Mirrors the admin unread-count pattern (same supportLastSeenAt field).
exports.getPartnerUnreadCount = async (req, res) => {
  try {
    const since = req.user.supportLastSeenAt || new Date(0);
    const tickets = await Ticket.find({ partnerId: req.user._id })
      .select('messages.senderRole messages.createdAt')
      .lean();
    let count = 0;
    for (const t of tickets) {
      for (const m of t.messages || []) {
        if (m.senderRole === 'admin' && m.createdAt && new Date(m.createdAt) > since) {
          count += 1;
        }
      }
    }
    res.json({ success: true, count });
  } catch (error) {
    console.error('getPartnerUnreadCount Error:', error);
    res.status(500).json({ success: false, message: 'Failed to get unread count' });
  }
};

exports.addMessage = async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !String(text).trim()) {
      return res.status(400).json({ success: false, message: 'Message text is required' });
    }
    if (String(text).trim().length > 2000) {
      return res.status(400).json({ success: false, message: 'Message too long (max 2000 chars)' });
    }

    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    const isAdmin = req.user.role === 'admin';

    // Partner: own tickets only, cannot reply once resolved
    if (!isAdmin) {
      if (String(ticket.partnerId) !== String(req.user._id)) {
        return res.status(403).json({ success: false, message: 'Not authorized' });
      }
      if (ticket.status === 'resolved') {
        return res.status(400).json({ success: false, message: 'Ticket is resolved. Please raise a new ticket.' });
      }
    }

    ticket.messages.push({
      sender: req.user._id,
      senderRole: isAdmin ? 'admin' : 'user',
      text: String(text).trim(),
    });
    ticket.lastReplyAt = new Date();
    // Admin replying to an open ticket moves it to in-progress
    if (isAdmin && ticket.status === 'open') {
      ticket.status = 'in-progress';
    }
    if (!ticket.assignedAdminId && isAdmin) {
      ticket.assignedAdminId = req.user._id;
    }
    await ticket.save();
    await ticket.populate('messages.sender', 'name role');

    res.json({ success: true, data: ticket, message: 'Reply added' });
  } catch (error) {
    console.error('addMessage Error:', error);
    res.status(500).json({ success: false, message: 'Failed to add reply' });
  }
};

// ==========================================
// ADMIN CONTROLLERS
// ==========================================

const getUserIdFilter = async (partnerSearch) => {
  if (!partnerSearch) return null;
  const users = await User.find({
    $or: [
      { name: { $regex: partnerSearch, $options: 'i' } },
      { email: { $regex: partnerSearch, $options: 'i' } }
    ]
  }).select('_id');
  return users.map(u => u._id);
};

exports.getAllTickets = async (req, res) => {
  try {
    const { page = 1, limit = 50, status, category, partnerSearch } = req.query;

    let query = {};

    if (status && status !== 'all') {
      query.status = status;
    }

    if (category && category !== 'all') {
      query.category = category;
    }

    if (partnerSearch) {
      const userIds = await getUserIdFilter(partnerSearch);
      query.partnerId = { $in: userIds };
    }

    const total = await Ticket.countDocuments(query);
    const tickets = await Ticket.find(query)
      .populate('partnerId', 'name email phone')
      .populate('assignedAdminId', 'name email')
      .populate('messages.sender', 'name role')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    res.json({
      success: true,
      data: tickets,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('getAllTickets Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch tickets' });
  }
};

exports.getTicketById = async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id)
      .populate('partnerId', 'name email phone')
      .populate('assignedAdminId', 'name email')
      .populate('messages.sender', 'name role');

    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    res.json({ success: true, data: ticket });
  } catch (error) {
    console.error('getTicketById Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch ticket' });
  }
};

exports.updateTicket = async (req, res) => {
  try {
    const { status, internalNotes } = req.body;
    const ticket = await Ticket.findById(req.params.id);

    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    const wasResolved = ticket.status === 'resolved';
    if (status) {
      ticket.status = status;
      if (status === 'resolved') {
        ticket.resolvedAt = new Date();
      } else {
        ticket.resolvedAt = null;
      }
    }

    if (internalNotes !== undefined) {
      ticket.internalNotes = internalNotes;
    }

    // Automatically assign to the admin who updates it if not assigned yet
    if (!ticket.assignedAdminId && req.user) {
      ticket.assignedAdminId = req.user._id;
    }

    await ticket.save();

    // Transition into resolved (not a re-save of an already-resolved ticket):
    // mail the partner with the ticket details. Fire-and-forget.
    if (status === 'resolved' && !wasResolved) {
      User.findById(ticket.partnerId).select('name email partner_id').lean()
        .then((partner) => {
          if (!partner?.email) return null;
          return sendTicketResolvedMail(partner.email, {
            name: partner.name,
            partnerId: partner.partner_id,
            ticketId: String(ticket._id),
            reference: ticket.reference,
            category: ticket.category,
            description: ticket.description,
            resolvedAt: ticket.resolvedAt,
          });
        })
        .catch((e) => console.error('[mail] ticket resolved notify failed:', e.message));
    }

    res.json({ success: true, data: ticket, message: 'Ticket updated successfully' });
  } catch (error) {
    console.error('updateTicket Error:', error);
    res.status(500).json({ success: false, message: 'Failed to update ticket' });
  }
};

exports.getUnreadCount = async (req, res) => {
  try {
    // Count tickets created AFTER this admin last viewed the Support page.
    // If they've never visited, use epoch 0 so all existing tickets count.
    const since = req.user.supportLastSeenAt || new Date(0);
    const count = await Ticket.countDocuments({ createdAt: { $gt: since } });
    res.json({ success: true, count });
  } catch (error) {
    console.error('getUnreadCount Error:', error);
    res.status(500).json({ success: false, message: 'Failed to get unread count' });
  }
};

// Stamps the current time as the admin's last-viewed timestamp for support tickets.
// Called by the frontend when the admin opens /admin/support.
exports.markTicketsSeen = async (req, res) => {
  try {
    await req.user.updateOne({ supportLastSeenAt: new Date() });
    res.json({ success: true });
  } catch (error) {
    console.error('markTicketsSeen Error:', error);
    res.status(500).json({ success: false, message: 'Failed to mark tickets seen' });
  }
};
