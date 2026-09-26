const AIAnalysis = require('../models/AIAnalysis');
const CreditReport = require('../models/creditReport');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

const Ticket = require('../models/Ticket');

exports.getOverviewSummary = async (req, res) => {
  try {
    const now = new Date();

    // Today: midnight → now
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    // Yesterday (for trend delta)
    const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const yesterdayEnd = new Date(todayEnd); yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);

    // This month / last month
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    // New partners this week
    const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - 7);

    const [
      aiToday, crToday,
      aiYesterday, crYesterday,
      aiMonth, crMonth,
      aiPrevMonth, crPrevMonth,
      aiFailedMonth, crFailedMonth,
      totalWalletBalance,
      recentRecharge,
      totalPartners, newPartnersWeek,
      revenueMonthAgg, revenuePrevMonthAgg,
      openTickets, inProgressTickets,
    ] = await Promise.all([
      AIAnalysis.countDocuments({ status: 'completed', createdAt: { $gte: todayStart, $lte: todayEnd } }),
      CreditReport.countDocuments({ status: 'Success',    createdAt: { $gte: todayStart, $lte: todayEnd } }),
      AIAnalysis.countDocuments({ status: 'completed', createdAt: { $gte: yesterdayStart, $lte: yesterdayEnd } }),
      CreditReport.countDocuments({ status: 'Success',    createdAt: { $gte: yesterdayStart, $lte: yesterdayEnd } }),
      AIAnalysis.countDocuments({ status: 'completed', createdAt: { $gte: monthStart, $lte: monthEnd } }),
      CreditReport.countDocuments({ status: 'Success',    createdAt: { $gte: monthStart, $lte: monthEnd } }),
      AIAnalysis.countDocuments({ status: 'completed', createdAt: { $gte: prevMonthStart, $lte: prevMonthEnd } }),
      CreditReport.countDocuments({ status: 'Success',    createdAt: { $gte: prevMonthStart, $lte: prevMonthEnd } }),
      AIAnalysis.countDocuments({ status: 'failed', createdAt: { $gte: monthStart, $lte: monthEnd } }),
      CreditReport.countDocuments({ status: 'Failed', createdAt: { $gte: monthStart, $lte: monthEnd } }),
      User.aggregate([
        { $match: { role: { $ne: 'admin' } } },
        { $group: { _id: null, total: { $sum: '$walletBalance' } } }
      ]),
      Transaction.findOne({
        type: 'CREDIT',
        status: 'SUCCESS',
        createdAt: { $gte: monthStart, $lte: monthEnd }
      }).select('_id').lean(),
      User.countDocuments({ role: { $ne: 'admin' } }),
      User.countDocuments({ role: { $ne: 'admin' }, createdAt: { $gte: weekStart } }),
      Transaction.aggregate([
        { $match: { type: 'CREDIT', status: 'SUCCESS', createdAt: { $gte: monthStart, $lte: monthEnd } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Transaction.aggregate([
        { $match: { type: 'CREDIT', status: 'SUCCESS', createdAt: { $gte: prevMonthStart, $lte: prevMonthEnd } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Ticket.countDocuments({ status: 'open' }),
      Ticket.countDocuments({ status: 'in-progress' }),
    ]);

    const walletBalance = totalWalletBalance.length > 0 ? totalWalletBalance[0].total : 0;
    const reportsToday = aiToday + crToday;
    const reportsYesterday = aiYesterday + crYesterday;
    const reportsThisMonth = aiMonth + crMonth;
    const reportsPrevMonth = aiPrevMonth + crPrevMonth;
    const failedThisMonth = aiFailedMonth + crFailedMonth;
    const revenueMonth = revenueMonthAgg.length > 0 ? revenueMonthAgg[0].total : 0;
    const revenuePrevMonth = revenuePrevMonthAgg.length > 0 ? revenuePrevMonthAgg[0].total : 0;

    const pctChange = (curr, prev) => {
      if (!prev) return curr > 0 ? 100 : 0;
      return Math.round(((curr - prev) / prev) * 100);
    };

    const totalAttemptsMonth = reportsThisMonth + failedThisMonth;
    const successRate = totalAttemptsMonth > 0
      ? Math.round((reportsThisMonth / totalAttemptsMonth) * 100) : 100;

    res.json({
      success: true,
      data: {
        reportsToday,
        reportsYesterday,
        todayDeltaPct: pctChange(reportsToday, reportsYesterday),
        reportsThisMonth,
        reportsPrevMonth,
        monthDeltaPct: pctChange(reportsThisMonth, reportsPrevMonth),
        failedThisMonth,
        successRate,
        walletBalance,
        hasRecentRecharge: !!recentRecharge,
        totalPartners,
        newPartnersWeek,
        revenueMonth,
        revenuePrevMonth,
        revenueDeltaPct: pctChange(revenueMonth, revenuePrevMonth),
        openTickets,
        inProgressTickets,
      }
    });
  } catch (err) {
    console.error('getOverviewSummary Error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch overview summary' });
  }
};

// ─── Pro dashboard widgets ───

// Daily volume + revenue for last N days (default 14)
exports.getTimeseries = async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || '14', 10), 90);
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1));

    const [aiRows, crRows, revRows] = await Promise.all([
      AIAnalysis.aggregate([
        { $match: { status: 'completed', createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      ]),
      CreditReport.aggregate([
        { $match: { status: 'Success', createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: { type: 'CREDIT', status: 'SUCCESS', createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: '$amount' } } },
      ]),
    ]);

    const aiMap = Object.fromEntries(aiRows.map(r => [r._id, r.count]));
    const crMap = Object.fromEntries(crRows.map(r => [r._id, r.count]));
    const revMap = Object.fromEntries(revRows.map(r => [r._id, r.total]));

    const series = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const ai = aiMap[key] || 0, cr = crMap[key] || 0;
      series.push({ date: key, label, reports: ai + cr, ai, credit: cr, revenue: revMap[key] || 0 });
    }
    res.json({ success: true, data: series });
  } catch (err) {
    console.error('getTimeseries Error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch timeseries' });
  }
};

exports.getBureauSplit = async (req, res) => {
  try {
    const [ai, bureaus] = await Promise.all([
      AIAnalysis.countDocuments({ status: 'completed' }),
      CreditReport.aggregate([
        { $match: { status: 'Success' } },
        { $group: { _id: '$bureau', count: { $sum: 1 } } },
      ]),
    ]);
    // Always list every known bureau (zero-filled) so new bureaus like
    // EQUIFAX show a section even before their first successful pull.
    const ORDER = ['EXPERIAN', 'CRIF', 'CIBIL', 'EQUIFAX'];
    const counts = Object.fromEntries(bureaus.map(b => [String(b._id || 'Unknown').toUpperCase(), b.count]));
    const data = [
      { name: 'AI Analysis', value: ai },
      ...ORDER.map(name => ({ name, value: counts[name] || 0 })),
      ...Object.entries(counts)
        .filter(([name]) => name !== 'UNKNOWN' && !ORDER.includes(name))
        .map(([name, value]) => ({ name, value })),
    ];
    res.json({ success: true, data });
  } catch (err) {
    console.error('getBureauSplit Error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch bureau split' });
  }
};

exports.getScoreDistribution = async (req, res) => {
  try {
    const [crScores, aiScores] = await Promise.all([
      CreditReport.find({ status: 'Success', score: { $ne: null } }).select('score').lean(),
      AIAnalysis.find({ status: 'completed', 'result.score': { $ne: null } }).select('result.score').lean(),
    ]);
    const buckets = [
      { name: '< 650', count: 0 },
      { name: '650–749', count: 0 },
      { name: '750+', count: 0 },
    ];
    const put = (s) => {
      if (s == null) return;
      if (s < 650) buckets[0].count++;
      else if (s < 750) buckets[1].count++;
      else buckets[2].count++;
    };
    crScores.forEach(r => put(r.score));
    aiScores.forEach(r => put(r.result?.score));
    res.json({ success: true, data: buckets });
  } catch (err) {
    console.error('getScoreDistribution Error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch score distribution' });
  }
};

exports.getTopPartners = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '5', 10), 20);
    const [crAgg, aiAgg] = await Promise.all([
      CreditReport.aggregate([
        { $match: { status: 'Success' } },
        { $group: { _id: '$userId', count: { $sum: 1 } } },
        { $sort: { count: -1 } }, { $limit: 50 },
      ]),
      AIAnalysis.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: '$userId', count: { $sum: 1 } } },
        { $sort: { count: -1 } }, { $limit: 50 },
      ]),
    ]);
    const totals = {};
    [...crAgg, ...aiAgg].forEach(r => {
      const k = String(r._id);
      totals[k] = (totals[k] || 0) + r.count;
    });
    const topIds = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, limit);
    const users = await User.find({ _id: { $in: topIds.map(([id]) => id) } }).select('name email').lean();
    const nameMap = Object.fromEntries(users.map(u => [String(u._id), u.name || u.email]));
    // Merge rows that resolve to the same display name (e.g. several deleted
    // partners all showing as "Unknown") so the chart stays clean.
    const merged = new Map();
    topIds.forEach(([id, count]) => {
      const name = nameMap[id] || 'Unknown';
      merged.set(name, (merged.get(name) || 0) + count);
    });
    const data = [...merged.entries()]
      .map(([name, reports]) => ({ name, reports }))
      .sort((a, b) => b.reports - a.reports)
      .slice(0, limit);
    res.json({ success: true, data });
  } catch (err) {
    console.error('getTopPartners Error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch top partners' });
  }
};

exports.getRecentActivity = async (req, res) => {
  try {
    const [recentCr, recentAi, recentTickets, lowWallets] = await Promise.all([
      CreditReport.find({}).sort({ createdAt: -1 }).limit(8)
        .populate('userId', 'name email').select('bureau score status createdAt userId name').lean(),
      AIAnalysis.find({}).sort({ createdAt: -1 }).limit(8)
        .populate('userId', 'name email').select('status createdAt userId fileName result.score').lean(),
      Ticket.find({}).sort({ createdAt: -1 }).limit(3)
        .populate('partnerId', 'name email').select('category status createdAt partnerId').lean(),
      User.find({ role: { $ne: 'admin' }, walletBalance: { $lt: 500 } })
        .sort({ walletBalance: 1 }).limit(5).select('name email walletBalance').lean(),
    ]);

    const pulls = [
      ...recentCr.map(r => ({
        id: r._id, type: 'Credit Report', customer: r.name || '—',
        partner: r.userId?.name || r.userId?.email || 'Unknown',
        bureau: r.bureau || '—', score: r.score ?? '—',
        status: r.status, createdAt: r.createdAt,
      })),
      ...recentAi.map(r => ({
        id: r._id, type: 'AI Analysis', customer: (r.fileName || '').replace(/\.[^/.]+$/, '') || '—',
        partner: r.userId?.name || r.userId?.email || 'Unknown',
        bureau: 'AI', score: r.result?.score ?? '—',
        status: r.status === 'completed' ? 'Success' : r.status, createdAt: r.createdAt,
      })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8);

    res.json({ success: true, data: { pulls, recentTickets, lowWallets } });
  } catch (err) {
    console.error('getRecentActivity Error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch recent activity' });
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
