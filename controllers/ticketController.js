const Ticket = require('../models/Ticket');
const User = require('../models/User');

// ==========================================
// PARTNER CONTROLLERS
// ==========================================

exports.createTicket = async (req, res) => {
  try {
    const { category, reference, description } = req.body;
    
    if (!category || !description) {
      return res.status(400).json({ success: false, message: 'Category and description are required' });
    }

    const newTicket = await Ticket.create({
      partnerId: req.user._id, // Assuming authMiddleware sets req.user
      category,
      reference,
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
      .sort({ createdAt: -1 });

    res.json({ success: true, data: tickets });
  } catch (error) {
    console.error('getMyTickets Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch tickets' });
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
      .sort({ createdAt: -1 })
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
      .populate('assignedAdminId', 'name email');

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
