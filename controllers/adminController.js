const AIAnalysis = require('../models/AIAnalysis');
const CreditReport = require('../models/creditReport');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

exports.getOverviewSummary = async (req, res) => {
  try {
    const now = new Date();

    // Today: midnight → now
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    // This month: 1st day 00:00 → last day 23:59
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const [
      aiToday, crToday,
      aiMonth, crMonth,
      totalWalletBalance,
      recentRecharge
    ] = await Promise.all([
      // Reports today
      AIAnalysis.countDocuments({ status: 'completed', createdAt: { $gte: todayStart, $lte: todayEnd } }),
      CreditReport.countDocuments({ status: 'Success',    createdAt: { $gte: todayStart, $lte: todayEnd } }),

      // Reports this month
      AIAnalysis.countDocuments({ status: 'completed', createdAt: { $gte: monthStart, $lte: monthEnd } }),
      CreditReport.countDocuments({ status: 'Success',    createdAt: { $gte: monthStart, $lte: monthEnd } }),

      // Total wallet balance across all partner accounts
      User.aggregate([
        { $match: { role: { $ne: 'admin' } } },
        { $group: { _id: null, total: { $sum: '$walletBalance' } } }
      ]),

      // Any successful recharge this month?
      Transaction.findOne({
        type: 'CREDIT',
        status: 'SUCCESS',
        createdAt: { $gte: monthStart, $lte: monthEnd }
      }).select('_id').lean()
    ]);

    const walletBalance = totalWalletBalance.length > 0 ? totalWalletBalance[0].total : 0;

    res.json({
      success: true,
      data: {
        reportsToday:     aiToday + crToday,
        reportsThisMonth: aiMonth + crMonth,
        walletBalance,
        hasRecentRecharge: !!recentRecharge
      }
    });
  } catch (err) {
    console.error('getOverviewSummary Error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch overview summary' });
  }
};

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

exports.getAllAiAnalyses = async (req, res) => {
  try {
    const { page = 1, limit = 50, startDate, endDate, partnerSearch } = req.query;
    
    let query = { status: 'completed' };

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    if (partnerSearch) {
      const userIds = await getUserIdFilter(partnerSearch);
      query.userId = { $in: userIds };
    }

    const total = await AIAnalysis.countDocuments(query);
    const analyses = await AIAnalysis.find(query)
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      // Exclude large fields to save bandwidth
      .select('-rawModelResponse -filePath -htmlReport');

    res.json({
      success: true,
      data: analyses,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('getAllAiAnalyses Admin Error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch AI analyses' });
  }
};

exports.getAllCreditReports = async (req, res) => {
  try {
    const { page = 1, limit = 50, startDate, endDate, partnerSearch, bureau } = req.query;
    
    let query = { status: 'Success' };

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    if (bureau && bureau !== 'All') {
      query.bureau = bureau.toUpperCase();
    }

    if (partnerSearch) {
      const userIds = await getUserIdFilter(partnerSearch);
      query.userId = { $in: userIds };
    }

    const total = await CreditReport.countDocuments(query);
    const reports = await CreditReport.find(query)
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      // Exclude reportData to save bandwidth
      .select('-reportData');

    res.json({
      success: true,
      data: reports,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('getAllCreditReports Admin Error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch credit reports' });
  }
};

exports.getAllPartners = async (req, res) => {
  try {
    const { page = 1, limit = 50, search } = req.query;

    let query = { role: { $ne: 'admin' } };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }

    const total = await User.countDocuments(query);
    const users = await User.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .select('-password')
      .lean();

    // Fetch stats for the paginated users concurrently
    const partnersWithStats = await Promise.all(
      users.map(async (user) => {
        const [crCount, aiCount, lastCr, lastAi] = await Promise.all([
          CreditReport.countDocuments({ userId: user._id, status: 'Success' }),
          AIAnalysis.countDocuments({ userId: user._id, status: 'completed' }),
          CreditReport.findOne({ userId: user._id }).sort({ createdAt: -1 }).select('createdAt').lean(),
          AIAnalysis.findOne({ userId: user._id }).sort({ createdAt: -1 }).select('createdAt').lean()
        ]);

        const totalReports = crCount + aiCount;
        
        // Find most recent date
        let lastReportDate = null;
        const crDate = lastCr ? new Date(lastCr.createdAt) : null;
        const aiDate = lastAi ? new Date(lastAi.createdAt) : null;
        
        if (crDate && aiDate) {
          lastReportDate = crDate > aiDate ? crDate : aiDate;
        } else {
          lastReportDate = crDate || aiDate || null;
        }

        return {
          ...user,
          totalReports,
          lastReportDate
        };
      })
    );

    res.json({
      success: true,
      data: partnersWithStats,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('getAllPartners Admin Error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch partners' });
  }
};
