const AIAnalysis = require('../models/AIAnalysis');
const CreditReport = require('../models/creditReport');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Ticket = require('../models/Ticket');
const Pricing = require('../models/Pricing');
const { PLAN_KEYS, quoteForProduct } = require('../models/Pricing');

const pctChange = (curr, prev) => {
  if (!prev) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 100);
};

// GET /api/partner/overview/summary — partner-scoped KPIs + live wallet + spend
exports.getSummary = async (req, res) => {
  try {
    const userId = req.user._id;
    const now = new Date();

    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const yesterdayEnd = new Date(todayEnd); yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - 7);

    const [
      aiToday, crToday,
      aiYesterday, crYesterday,
      aiMonth, crMonth,
      aiPrevMonth, crPrevMonth,
      aiFailed, crFailed,
      me,
      spentAgg,
      lastRecharge,
      openTickets, inProgressTickets,
      avgAgg,
    ] = await Promise.all([
      AIAnalysis.countDocuments({ userId, status: 'completed', createdAt: { $gte: todayStart, $lte: todayEnd } }),
      CreditReport.countDocuments({ userId, status: 'Success', createdAt: { $gte: todayStart, $lte: todayEnd } }),
      AIAnalysis.countDocuments({ userId, status: 'completed', createdAt: { $gte: yesterdayStart, $lte: yesterdayEnd } }),
      CreditReport.countDocuments({ userId, status: 'Success', createdAt: { $gte: yesterdayStart, $lte: yesterdayEnd } }),
      AIAnalysis.countDocuments({ userId, status: 'completed', createdAt: { $gte: monthStart, $lte: monthEnd } }),
      CreditReport.countDocuments({ userId, status: 'Success', createdAt: { $gte: monthStart, $lte: monthEnd } }),
      AIAnalysis.countDocuments({ userId, status: 'completed', createdAt: { $gte: prevMonthStart, $lte: prevMonthEnd } }),
      CreditReport.countDocuments({ userId, status: 'Success', createdAt: { $gte: prevMonthStart, $lte: prevMonthEnd } }),
      AIAnalysis.countDocuments({ userId, status: 'failed', createdAt: { $gte: monthStart, $lte: monthEnd } }),
      CreditReport.countDocuments({ userId, status: 'Failed', createdAt: { $gte: monthStart, $lte: monthEnd } }),
      User.findById(userId).select('walletBalance').lean(),
      Transaction.aggregate([
        { $match: { userId: userId, type: 'DEBIT', status: 'SUCCESS', createdAt: { $gte: monthStart, $lte: monthEnd } } },
        // Fallback: older rows may store lowercase status
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Transaction.findOne({ userId, type: 'CREDIT', status: 'SUCCESS' }).sort({ createdAt: -1 }).select('amount createdAt').lean(),
      Ticket.countDocuments({ partnerId: userId, status: 'open' }),
      Ticket.countDocuments({ partnerId: userId, status: 'in-progress' }),
      CreditReport.aggregate([
        { $match: { userId: userId, status: 'Success', score: { $ne: null } } },
        { $group: { _id: null, avg: { $avg: '$score' }, count: { $sum: 1 } } },
      ]),
    ]);

    const reportsToday = aiToday + crToday;
    const reportsYesterday = aiYesterday + crYesterday;
    const reportsThisMonth = aiMonth + crMonth;
    const reportsPrevMonth = aiPrevMonth + crPrevMonth;
    const failedThisMonth = aiFailed + crFailed;
    const attempts = reportsThisMonth + failedThisMonth;
    const weekCount = await AIAnalysis.countDocuments({ userId, status: 'completed', createdAt: { $gte: weekStart } })
      .then((a) => CreditReport.countDocuments({ userId, status: 'Success', createdAt: { $gte: weekStart } }).then((c) => a + c));

    res.json({
      success: true,
      data: {
        reportsToday,
        todayDeltaPct: pctChange(reportsToday, reportsYesterday),
        reportsThisMonth,
        monthDeltaPct: pctChange(reportsThisMonth, reportsPrevMonth),
        failedThisMonth,
        successRate: attempts > 0 ? Math.round((reportsThisMonth / attempts) * 100) : 100,
        walletBalance: me?.walletBalance ?? 0,
        spentThisMonth: spentAgg.length > 0 ? spentAgg[0].total : 0,
        lastRecharge,
        openTickets,
        inProgressTickets,
        avgScore: avgAgg.length > 0 ? Math.round(avgAgg[0].avg) : null,
        scoredCount: avgAgg.length > 0 ? avgAgg[0].count : 0,
        pullsThisWeek: weekCount,
      },
    });
  } catch (err) {
    console.error('partner getSummary Error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch partner summary' });
  }
};

// GET /api/partner/overview/timeseries?days=14 — daily pulls + spend
exports.getTimeseries = async (req, res) => {
  try {
    const userId = req.user._id;
    const days = Math.min(parseInt(req.query.days || '14', 10), 90);
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1));

    const [aiRows, crRows, spendRows] = await Promise.all([
      AIAnalysis.aggregate([
        { $match: { userId, status: 'completed', createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      ]),
      CreditReport.aggregate([
        { $match: { userId, status: 'Success', createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: { userId, type: 'DEBIT', status: 'SUCCESS', createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: '$amount' } } },
      ]),
    ]);

    const aiMap = Object.fromEntries(aiRows.map((r) => [r._id, r.count]));
    const crMap = Object.fromEntries(crRows.map((r) => [r._id, r.count]));
    const spendMap = Object.fromEntries(spendRows.map((r) => [r._id, r.total]));

    const series = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const ai = aiMap[key] || 0, cr = crMap[key] || 0;
      series.push({ date: key, label, reports: ai + cr, spend: spendMap[key] || 0 });
    }
    res.json({ success: true, data: series });
  } catch (err) {
    console.error('partner getTimeseries Error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch timeseries' });
  }
};

// GET /api/partner/overview/score-mix — my score bands
exports.getScoreMix = async (req, res) => {
  try {
    const userId = req.user._id;
    const [crScores, aiScores] = await Promise.all([
      CreditReport.find({ userId, status: 'Success', score: { $ne: null } }).select('score').lean(),
      AIAnalysis.find({ userId, status: 'completed', 'result.score': { $ne: null } }).select('result.score').lean(),
    ]);
    const buckets = [
      { name: '< 650', count: 0 },
      { name: '650–749', count: 0 },
      { name: '750+', count: 0 },
    ];
    const put = (val) => {
      if (val == null) return;
      if (val < 650) buckets[0].count++;
      else if (val < 750) buckets[1].count++;
      else buckets[2].count++;
    };
    crScores.forEach((r) => put(r.score));
    aiScores.forEach((r) => put(r.result?.score));
    res.json({ success: true, data: buckets });
  } catch (err) {
    console.error('partner getScoreMix Error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch score mix' });
  }
};

// GET /api/partner/overview/recent — latest pulls + transactions + tickets
exports.getRecent = async (req, res) => {
  try {
    const userId = req.user._id;
    const [recentCr, recentAi, recentTxns, recentTickets] = await Promise.all([
      CreditReport.find({ userId }).sort({ createdAt: -1 }).limit(8)
        .select('bureau score status createdAt name').lean(),
      AIAnalysis.find({ userId }).sort({ createdAt: -1 }).limit(8)
        .select('status createdAt fileName result.score').lean(),
      Transaction.find({ userId }).sort({ createdAt: -1 }).limit(5)
        .select('type amount status purpose createdAt').lean(),
      Ticket.find({ partnerId: userId }).sort({ createdAt: -1 }).limit(3)
        .select('category status createdAt').lean(),
    ]);

    const pulls = [
      ...recentCr.map((r) => ({
        id: r._id, customer: r.name || '—', bureau: r.bureau || '—',
        score: r.score ?? '—', status: r.status, createdAt: r.createdAt,
      })),
      ...recentAi.map((r) => ({
        id: r._id, customer: (r.fileName || '').replace(/\.[^/.]+$/, '') || '—', bureau: 'AI',
        score: r.result?.score ?? '—',
        status: r.status === 'completed' ? 'Success' : r.status, createdAt: r.createdAt,
      })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8);

    res.json({ success: true, data: { pulls, recentTxns, recentTickets } });
  } catch (err) {
    console.error('partner getRecent Error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch recent activity' });
  }
};

// GET /api/partner/prefill?mobile=XXXXXXXXXX
// Returns the partner's most recent customer record for that mobile so
// report forms can prefill. Strictly scoped to the requester — a partner
// can never see another partner's customers.
exports.getPrefill = async (req, res) => {
  try {
    const mobile = String(req.query.mobile || "").replace(/\D/g, "");
    if (!/^\d{10}$/.test(mobile)) {
      return res.status(400).json({ success: false, message: "Valid 10-digit mobile number required" });
    }

    const record =
      (await CreditReport.findOne({ userId: req.user._id, mobile, status: "Success" })
        .sort({ createdAt: -1 })
        .select("name mobile pan gender email bureau createdAt")
        .lean()) ||
      (await CreditReport.findOne({ userId: req.user._id, mobile })
        .sort({ createdAt: -1 })
        .select("name mobile pan gender email bureau createdAt")
        .lean());

    if (!record) {
      return res.json({ success: true, found: false });
    }

    const parts = String(record.name || "").trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] || "";
    const lastName = parts.slice(1).join(" ");

    res.json({
      success: true,
      found: true,
      data: {
        firstName,
        lastName,
        mobile: record.mobile,
        pan: record.pan || "",
        gender: record.gender || "",
        email: record.email || "",
        bureau: record.bureau || "",
        pulledAt: record.createdAt,
      },
    });
  } catch (err) {
    console.error("partner getPrefill Error:", err);
    res.status(500).json({ success: false, message: "Could not fetch prefill data" });
  }
};
// GET /api/partner/pricing/plans � PUBLIC price list for the Plans page.
// Computed totals only; the frontend never does money math. Falls back to
// the founder table when the Pricing doc is missing.
exports.getPublicPlans = async (req, res) => {
  try {
    const pricing = await Pricing.findOne({ key: "default" }).lean();
    const plans = {};
    for (const plan of PLAN_KEYS) {
      const row = pricing?.plans?.[plan] || {};
      plans[plan] = {
        recharge: row.recharge ?? 0,
        cibil: row.cibil ?? 0,
        experian: row.experian ?? 0,
        crif: row.crif ?? 0,
        equifax: row.equifax ?? 0,
        cibilFailed: row.cibilFailed ?? 0,
      };
    }
    const ai = pricing
      ? quoteForProduct(pricing, "ai", "starter", "success")
      : { base: 100, gstRate: 18, gstAmount: 18, total: 118 };
    const otherFailed = pricing
      ? quoteForProduct(pricing, "experian", "starter", "fail")
      : { base: 30, gstRate: 0, gstAmount: 0, total: 30 };
    res.json({
      success: true,
      data: {
        plans,
        ai: { base: ai.base, gstRate: ai.gstRate, total: ai.total },
        otherFailedCharge: otherFailed.total,
        minRecharge: pricing?.minRecharge ?? 100,
      },
    });
  } catch (err) {
    console.error("partner getPublicPlans Error:", err);
    res.status(500).json({ success: false, message: "Could not fetch plans" });
  }
};
