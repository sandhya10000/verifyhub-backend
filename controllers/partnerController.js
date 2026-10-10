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
      User.findById(userId).select('walletBalance activePlan pendingPlanChoice').lean(),
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
        activePlan: me?.activePlan || null,
        pendingPlanChoice: me?.pendingPlanChoice ?? false,
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

    // Business day = Asia/Kolkata, computed explicitly — never from the
    // server clock. The old code mixed UTC keys (toISOString / $dateToString
    // default) with server-local labels, so today's pulls landed in a bucket
    // key the series didn't contain and the chart showed 0 for today.
    // IST has no DST (+05:30 fixed), so plain arithmetic is exact.
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istParts = (t) => {
      const d = new Date(t + IST_OFFSET_MS);
      return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate() };
    };
    const pad2 = (n) => String(n).padStart(2, '0');
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const nowP = istParts(Date.now());
    const todayIstMidnight = Date.UTC(nowP.y, nowP.m, nowP.day) - IST_OFFSET_MS;
    const start = new Date(todayIstMidnight - (days - 1) * 86400000);
    const dayKey = (t) => {
      const p = istParts(t);
      return `${p.y}-${pad2(p.m + 1)}-${pad2(p.day)}`;
    };

    const [aiRows, crRows, spendRows] = await Promise.all([
      AIAnalysis.aggregate([
        { $match: { userId, status: 'completed', createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } }, count: { $sum: 1 } } },
      ]),
      CreditReport.aggregate([
        { $match: { userId, status: 'Success', createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: { userId, type: 'DEBIT', status: 'SUCCESS', createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } }, total: { $sum: '$amount' } } },
      ]),
    ]);

    const aiMap = Object.fromEntries(aiRows.map((r) => [r._id, r.count]));
    const crMap = Object.fromEntries(crRows.map((r) => [r._id, r.count]));
    const spendMap = Object.fromEntries(spendRows.map((r) => [r._id, r.total]));

    const series = [];
    for (let i = 0; i < days; i++) {
      const t = start.getTime() + i * 86400000;
      const p = istParts(t);
      const key = dayKey(t);
      const label = `${p.day} ${MONTHS[p.m]}`;
      const ai = aiMap[key] || 0, cr = crMap[key] || 0;
      series.push({ date: key, label, reports: ai + cr, spend: spendMap[key] || 0 });
    }
    res.json({ success: true, data: series });
  } catch (err) {
    console.error('partner getTimeseries Error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch timeseries' });
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
      Transaction.find({ userId }).sort({ createdAt: -1 }).limit(15)
        .select('type amount totalAmount status purpose createdAt').lean(),
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
    // Single-plan launch: AI failure is flat ₹100 (base, no GST).
    // TODO(multi-plan-restore): drop aiFail, frontend falls back to otherFailedCharge.
    const aiFail = pricing
      ? quoteForProduct(pricing, "ai", "starter", "fail")
      : { base: 100, gstRate: 0, gstAmount: 0, total: 100 };
    const rc = pricing
      ? quoteForProduct(pricing, "rc", "starter", "success")
      : { base: 10, gstRate: 0, gstAmount: 0, total: 10 };
    const gst = pricing
      ? quoteForProduct(pricing, "gst", "starter", "success")
      : { base: 10, gstRate: 0, gstAmount: 0, total: 10 };
    res.json({
      success: true,
      data: {
        plans,
        ai: { base: ai.base, gstRate: ai.gstRate, total: ai.total },
        aiFail: { base: aiFail.base, gstRate: aiFail.gstRate, total: aiFail.total },
        otherFailedCharge: otherFailed.total,
        rc: { base: rc.base, gstRate: rc.gstRate, total: rc.total },
        gst: { base: gst.base, gstRate: gst.gstRate, total: gst.total },
        minRecharge: pricing?.minRecharge ?? 1000,
        singlePlanMode: true, // TODO(multi-plan-restore): remove flag once multi-tier returns
        singlePlanKey: "starter",
      },
    });
  } catch (err) {
    console.error("partner getPublicPlans Error:", err);
    res.status(500).json({ success: false, message: "Could not fetch plans" });
  }
};

// GET /api/partner/profile?range=lifetime|month|week — own user doc +
// ranged money/report summary. Strictly scoped to the requester.
exports.getProfile = async (req, res) => {
  try {
    const userId = req.user._id;
    const user = await User.findById(userId).select("-password").lean();
    if (!user) return res.status(404).json({ success: false, message: "Partner not found" });

    const range = ["month", "week"].includes(req.query.range) ? req.query.range : "lifetime";
    const since = range === "month" ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      : range === "week" ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) : null;
    const ranged = since ? { createdAt: { $gte: since } } : {};

    const [crCount, aiCount, sums, lastCr, lastAi] = await Promise.all([
      CreditReport.countDocuments({ userId, ...ranged }),
      AIAnalysis.countDocuments({ userId, ...ranged }),
      Transaction.aggregate([
        { $match: { userId, status: "SUCCESS", ...(since ? { createdAt: { $gte: since } } : {}) } },
        {
          $group: {
            _id: null,
            recharged: { $sum: { $cond: [{ $eq: ["$type", "CREDIT"] }, "$amount", 0] } },
            spent: { $sum: { $cond: [{ $eq: ["$type", "DEBIT"] }, { $ifNull: ["$totalAmount", "$amount"] }, 0] } },
          },
        },
      ]),
      CreditReport.findOne({ userId }).sort({ createdAt: -1 }).select("createdAt").lean(),
      AIAnalysis.findOne({ userId }).sort({ createdAt: -1 }).select("createdAt").lean(),
    ]);
    const crDate = lastCr ? new Date(lastCr.createdAt) : null;
    const aiDate = lastAi ? new Date(lastAi.createdAt) : null;
    res.json({
      success: true,
      data: user,
      summary: {
        totalReports: crCount + aiCount,
        creditReports: crCount,
        aiAnalyses: aiCount,
        totalRecharged: sums[0]?.recharged ?? 0,
        totalSpent: sums[0]?.spent ?? 0,
        lastReportDate: crDate && aiDate ? (crDate > aiDate ? crDate : aiDate) : (crDate || aiDate || null),
        range,
      },
    });
  } catch (err) {
    console.error("partner getProfile Error:", err);
    res.status(500).json({ success: false, message: "Could not fetch profile" });
  }
};

// GET /api/partner/transactions?page&limit&purpose&type&status&startDate&endDate
// Own money ledger with filters + summary. Strictly scoped to the requester.
exports.getMyTransactions = async (req, res) => {
  try {
    const userId = req.user._id;
    const { page = 1, limit = 20, startDate, endDate, type, status, purpose } = req.query;
    const perPage = Math.min(parseInt(limit, 10) || 20, 100);

    const query = { userId };
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }
    if (type && type !== "All") query.type = String(type).toUpperCase();
    if (status && status !== "All") query.status = String(status).toUpperCase();
    if (purpose && purpose !== "All") query.purpose = purpose;

    const [total, rows, sums] = await Promise.all([
      Transaction.countDocuments(query),
      Transaction.find(query).sort({ createdAt: -1 })
        .skip((parseInt(page, 10) - 1) * perPage).limit(perPage).select("-signature").lean(),
      Transaction.aggregate([
        { $match: { ...query, status: "SUCCESS" } },
        {
          $group: {
            _id: null,
            credited: { $sum: { $cond: [{ $eq: ["$type", "CREDIT"] }, "$amount", 0] } },
            debited: { $sum: { $cond: [{ $eq: ["$type", "DEBIT"] }, { $ifNull: ["$totalAmount", "$amount"] }, 0] } },
          },
        },
      ]),
    ]);
    res.json({
      success: true, data: rows, total, page: parseInt(page, 10), pages: Math.ceil(total / perPage),
      summary: { credited: sums[0]?.credited ?? 0, debited: sums[0]?.debited ?? 0 },
    });
  } catch (err) {
    console.error("partner getMyTransactions Error:", err);
    res.status(500).json({ success: false, message: "Could not fetch transactions" });
  }
};
