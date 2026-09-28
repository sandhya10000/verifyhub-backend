const AIAnalysis = require('../models/AIAnalysis');
const CreditReport = require('../models/creditReport');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Ticket = require('../models/Ticket');

const pctChange = (curr, prev) => {
  if (!prev) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 100);
};

// IST day key (YYYY-MM-DD) for a Date — matches $dateToString + Asia/Kolkata
const istDayKey = (d) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
  return parts; // en-CA yields YYYY-MM-DD
};

exports.getOverviewSummary = async (req, res) => {
  try {
    const now = new Date();

    // Today: midnight → now
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    // Yesterday (trend deltas)
    const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const yesterdayEnd = new Date(todayEnd); yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);

    // This month / last month
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - 7);

    const [
      aiToday, crToday,
      aiYesterday, crYesterday,
      aiMonth, crMonth,
      aiPrevMonth, crPrevMonth,
      aiFailedMonth, crFailedMonth,
      totalWalletBalance,
      recentRecharge,
      totalPartners, newPartnersWeek, newPartnersToday,
      collectedAgg, collectedPrevAgg,
      consumedAgg, consumedPrevAgg,
      failFeeAgg,
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
      User.countDocuments({ role: { $ne: 'admin' }, createdAt: { $gte: todayStart, $lte: todayEnd } }),
      Transaction.aggregate([
        { $match: { type: 'CREDIT', status: 'SUCCESS', createdAt: { $gte: monthStart, $lte: monthEnd } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Transaction.aggregate([
        { $match: { type: 'CREDIT', status: 'SUCCESS', createdAt: { $gte: prevMonthStart, $lte: prevMonthEnd } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Transaction.aggregate([
        { $match: { type: 'DEBIT', status: 'SUCCESS', createdAt: { $gte: monthStart, $lte: monthEnd } } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } }
      ]),
      Transaction.aggregate([
        { $match: { type: 'DEBIT', status: 'SUCCESS', createdAt: { $gte: prevMonthStart, $lte: prevMonthEnd } } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } }
      ]),
      Transaction.aggregate([
        { $match: { purpose: 'REPORT_FAIL_CHARGE', status: 'SUCCESS', createdAt: { $gte: monthStart, $lte: monthEnd } } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } }
      ]),
      Ticket.countDocuments({ status: 'open' }),
      Ticket.countDocuments({ status: 'in-progress' }),
    ]);

    const sum0 = (agg) => (agg.length > 0 ? agg[0].total : 0);
    const reportsToday = aiToday + crToday;
    const reportsThisMonth = aiMonth + crMonth;
    const failedThisMonth = aiFailedMonth + crFailedMonth;
    const collected = sum0(collectedAgg);
    const consumed = sum0(consumedAgg);
    const attempts = reportsThisMonth + failedThisMonth;

    res.json({
      success: true,
      data: {
        reportsToday,
        todayDeltaPct: pctChange(reportsToday, aiYesterday + crYesterday),
        reportsThisMonth,
        monthDeltaPct: pctChange(reportsThisMonth, aiPrevMonth + crPrevMonth),
        failedThisMonth,
        successRate: attempts > 0 ? Math.round((reportsThisMonth / attempts) * 100) : 100,
        walletBalance: sum0(totalWalletBalance),
        hasRecentRecharge: !!recentRecharge,
        totalPartners,
        newPartnersWeek,
        newPartnersToday,
        collectedMonth: collected,
        collectedDeltaPct: pctChange(collected, sum0(collectedPrevAgg)),
        consumedMonth: consumed,
        consumedDeltaPct: pctChange(consumed, sum0(consumedPrevAgg)),
        netMonth: collected - consumed,
        failFeeMonth: sum0(failFeeAgg),
        openTickets,
        inProgressTickets,
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

const Pricing = require("../models/Pricing");
const { PLAN_KEYS, PRODUCT_KEYS } = require("../models/Pricing");
const { resetPricingCache } = require("../utils/wallet");
const { sendMail } = require("../utils/sendMail");

// PATCH /api/admin/partners/:id/status { isActive: boolean }
// Deactivate/reactivate a partner. Never targets admins or self.
exports.setPartnerStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    if (typeof isActive !== "boolean") {
      return res.status(400).json({ success: false, message: "isActive (boolean) is required" });
    }
    if (String(req.user?._id) === String(id)) {
      return res.status(400).json({ success: false, message: "You cannot change your own status" });
    }
    const target = await User.findById(id).select("role isActive").lean();
    if (!target) return res.status(404).json({ success: false, message: "Partner not found" });
    if (target.role === "admin") {
      return res.status(400).json({ success: false, message: "Admin accounts cannot be deactivated" });
    }
    if (target.isActive === isActive) {
      const full = await User.findById(id).select("-password").lean();
      return res.status(200).json({ success: true, duplicate: true, data: full });
    }
    const updated = await User.findByIdAndUpdate(id, { $set: { isActive } }, { new: true }).select("-password").lean();

    // Fire-and-forget status mail. Never blocks the admin response.
    if (updated?.email) {
      const active = isActive === true;
      sendMail({
        to: updated.email,
        subject: active ? "VerifyHub: your account is reactivated" : "VerifyHub: your account is suspended",
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #eee;border-radius:12px;padding:24px">
          <h2 style="margin:0 0 8px">VerifyHub — Account ${active ? "reactivated" : "suspended"}</h2>
          <p style="color:#42506b">Hi ${updated.name || "Partner"},</p>
          <p style="color:#42506b">${active
            ? "Good news — your account is active again. You can log in and continue pulling reports."
            : "Your account has been suspended by the admin. You can no longer log in or pull reports. Please contact support if you believe this is a mistake."}</p>
        </div>`,
        text: active
          ? `Hi ${updated.name || "Partner"}, your VerifyHub account is active again.`
          : `Hi ${updated.name || "Partner"}, your VerifyHub account has been suspended. Please contact support.`,
      }).catch((e) => console.error("[mail] partner status mail failed:", e.message));
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    console.error("setPartnerStatus Admin Error:", err);
    res.status(500).json({ success: false, message: "Could not update partner status" });
  }
};

// POST /api/admin/partners/:id/add-funds { amount, note? }
// Admin wallet top-up: no GST, credited amount is final. Ledgered as
// ADD_FUNDS / ADMIN and notified to the partner by mail.
exports.addFundsToPartner = async (req, res) => {
  try {
    const { id } = req.params;
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    const note = String(req.body?.note || "").trim().slice(0, 200);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: "A positive amount is required" });
    }
    if (amount > 1000000) {
      return res.status(400).json({ success: false, message: "Amount exceeds the ₹10,00,000 per-top-up limit" });
    }
    const target = await User.findById(id).select("role name email partner_id walletBalance").lean();
    if (!target) return res.status(404).json({ success: false, message: "Partner not found" });
    if (target.role === "admin") {
      return res.status(400).json({ success: false, message: "Cannot top up an admin account" });
    }

    const updated = await User.findByIdAndUpdate(id, { $inc: { walletBalance: amount } }, { new: true }).select("-password").lean();
    if (!updated) return res.status(404).json({ success: false, message: "Partner not found" });

    const txn = await Transaction.create({
      userId: updated._id,
      orderId: `admin_${String(updated._id)}_${Date.now()}`,
      amount,
      gstAmount: 0,
      totalAmount: amount,
      currency: "INR",
      type: "CREDIT",
      purpose: "ADD_FUNDS",
      status: "SUCCESS",
      gateway: "ADMIN",
      description: note ? `Admin top-up by ${req.user?.email || "admin"}: ${note}` : `Admin top-up by ${req.user?.email || "admin"}`,
    });

    // Balance healthy again? Clear any stale low-balance flag.
    try {
      const pricing = await Pricing.findOne({ key: "default" }).select("lowBalanceThreshold").lean();
      if ((updated.walletBalance ?? 0) >= (pricing?.lowBalanceThreshold ?? 500)) {
        await User.updateOne({ _id: updated._id }, { $set: { lowBalanceLastAlertAt: null } });
      }
    } catch { /* non-fatal */ }

    // Fire-and-forget partner notification. Never blocks the response.
    if (updated.email) {
      const { sendAdminTopupMail } = require("../utils/sendMail");
      sendAdminTopupMail(updated.email, {
        name: updated.name, amount,
        prevBalance: target.walletBalance ?? 0,
        walletBalance: updated.walletBalance,
        note: note || null,
        transactionId: String(txn._id),
        partnerId: updated.partner_id, date: new Date(),
      }).catch((e) => console.error("[mail] admin top-up mail failed:", e.message));
    }

    res.json({
      success: true,
      data: { walletBalance: updated.walletBalance, prevBalance: target.walletBalance ?? 0, credited: amount, transactionId: txn._id },
    });
  } catch (err) {
    console.error("addFundsToPartner Admin Error:", err);
    res.status(500).json({ success: false, message: "Could not add funds" });
  }
};

exports.getPricing = async (req, res) => {
  try {
    const pricing = await Pricing.findOne({ key: "default" }).lean();
    if (!pricing) return res.status(404).json({ success: false, message: "Pricing not configured" });
    res.json({ success: true, data: pricing });
  } catch (err) {
    console.error("getPricing Admin Error:", err);
    res.status(500).json({ success: false, message: "Could not fetch pricing" });
  }
};

// PATCH /api/admin/pricing � whitelisted matrix edits only.
// Body may contain any subset of: plans.{starter,growth,pro,enterprise}.{recharge,cibil,experian,crif,equifax,cibilFailed},
// ai.{base,gstRate}, otherFailedCharge.{base,gstRate}, minRecharge, lowBalanceThreshold.
exports.updatePricing = async (req, res) => {
  try {
    const set = {};
    const num = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));

    for (const plan of PLAN_KEYS) {
      const row = req.body?.plans?.[plan];
      if (row && typeof row === "object") {
        for (const field of ["recharge", "cibil", "experian", "crif", "equifax", "cibilFailed"]) {
          const n = num(row[field]);
          if (n !== undefined && Number.isFinite(n) && n >= 0) set[`plans.${plan}.${field}`] = n;
        }
      }
    }
    for (const key of ["ai", "otherFailedCharge"]) {
      const obj = req.body?.[key];
      if (obj && typeof obj === "object") {
        for (const field of ["base", "gstRate"]) {
          const n = num(obj[field]);
          if (n !== undefined && Number.isFinite(n) && n >= 0) set[`${key}.${field}`] = n;
        }
      }
    }
    for (const field of ["minRecharge", "lowBalanceThreshold", "lowBalanceAlertIntervalDays"]) {
      const n = num(req.body?.[field]);
      if (n !== undefined && Number.isFinite(n) && n >= 0) set[field] = n;
    }

    if (Object.keys(set).length === 0) {
      return res.status(400).json({ success: false, message: "No valid pricing fields provided" });
    }

    const pricing = await Pricing.findOneAndUpdate({ key: "default" }, { $set: set }, { new: true }).lean();
    resetPricingCache(); // wallet quotes pick up the change within a minute at most
    res.json({ success: true, data: pricing });
  } catch (err) {
    console.error("updatePricing Admin Error:", err);
    res.status(500).json({ success: false, message: "Could not update pricing" });
  }
};

// --- Overview widget reads ---

// GET /api/admin/overview/money-timeseries?days=14
// Daily collected (recharges) vs consumed (debits) + pull counts.
exports.getMoneyTimeseries = async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || "14", 10), 90);
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1));

    const [inRows, outRows, aiRows, crRows] = await Promise.all([
      Transaction.aggregate([
        { $match: { type: "CREDIT", status: "SUCCESS", createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } }, total: { $sum: "$amount" } } },
      ]),
      Transaction.aggregate([
        { $match: { type: "DEBIT", status: "SUCCESS", createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } }, total: { $sum: "$totalAmount" } } },
      ]),
      AIAnalysis.aggregate([
        { $match: { status: "completed", createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } }, count: { $sum: 1 } } },
      ]),
      CreditReport.aggregate([
        { $match: { status: "Success", createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } }, count: { $sum: 1 } } },
      ]),
    ]);

    const inMap = Object.fromEntries(inRows.map((r) => [r._id, r.total]));
    const outMap = Object.fromEntries(outRows.map((r) => [r._id, r.total]));
    const aiMap = Object.fromEntries(aiRows.map((r) => [r._id, r.count]));
    const crMap = Object.fromEntries(crRows.map((r) => [r._id, r.count]));

    const series = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const key = istDayKey(d);
      series.push({
        date: key,
        label: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
        collected: inMap[key] || 0,
        consumed: outMap[key] || 0,
        reports: (aiMap[key] || 0) + (crMap[key] || 0),
      });
    }
    res.json({ success: true, data: series });
  } catch (err) {
    console.error("getMoneyTimeseries Error:", err);
    res.status(500).json({ success: false, message: "Could not fetch money trend" });
  }
};

// GET /api/admin/overview/plan-distribution
// Partners per tier + collected/consumed per tier (from stamped ledger rows).
exports.getPlanDistribution = async (req, res) => {
  try {
    const [partners, money] = await Promise.all([
      User.aggregate([
        { $match: { role: { $ne: "admin" } } },
        { $group: { _id: "$activePlan", count: { $sum: 1 }, float: { $sum: "$walletBalance" } } },
      ]),
      Transaction.aggregate([
        { $match: { status: "SUCCESS", planTier: { $ne: null } } },
        { $group: { _id: { tier: "$planTier", type: "$type" }, total: { $sum: { $cond: [{ $eq: ["$type", "CREDIT"] }, "$amount", "$totalAmount"] } } } },
      ]),
    ]);
    const tiers = ["startup", "starter", "growth", "pro", "enterprise"];
    const pMap = Object.fromEntries(partners.map((p) => [p._id || "starter", p]));
    const collected = {}, consumed = {};
    money.forEach((m) => {
      if (m._id.type === "CREDIT") collected[m._id.tier] = m.total;
      else consumed[m._id.tier] = m.total;
    });
    res.json({
      success: true,
      data: tiers.map((t) => ({
        tier: t,
        partners: pMap[t]?.count || 0,
        float: pMap[t]?.float || 0,
        collected: collected[t] || 0,
        consumed: consumed[t] || 0,
      })),
    });
  } catch (err) {
    console.error("getPlanDistribution Error:", err);
    res.status(500).json({ success: false, message: "Could not fetch plan distribution" });
  }
};

// GET /api/admin/overview/bureau-split � always lists every bureau (zero-filled)
exports.getBureauSplit = async (req, res) => {
  try {
    const [ai, bureaus] = await Promise.all([
      AIAnalysis.countDocuments({ status: "completed" }),
      CreditReport.aggregate([
        { $match: { status: "Success" } },
        { $group: { _id: "$bureau", count: { $sum: 1 } } },
      ]),
    ]);
    const ORDER = ["EXPERIAN", "CRIF", "CIBIL", "EQUIFAX"];
    const counts = Object.fromEntries(bureaus.map((b) => [String(b._id || "Unknown").toUpperCase(), b.count]));
    const data = [
      { name: "AI Analysis", value: ai },
      ...ORDER.map((name) => ({ name, value: counts[name] || 0 })),
      ...Object.entries(counts)
        .filter(([name]) => name !== "UNKNOWN" && !ORDER.includes(name))
        .map(([name, value]) => ({ name, value })),
    ];
    res.json({ success: true, data });
  } catch (err) {
    console.error("getBureauSplit Error:", err);
    res.status(500).json({ success: false, message: "Could not fetch bureau split" });
  }
};

// GET /api/admin/overview/score-mix
exports.getScoreMix = async (req, res) => {
  try {
    const [crScores, aiScores] = await Promise.all([
      CreditReport.find({ status: "Success", score: { $ne: null } }).select("score").lean(),
      AIAnalysis.find({ status: "completed", "result.score": { $ne: null } }).select("result.score").lean(),
    ]);
    const buckets = [
      { name: "< 650", count: 0 },
      { name: "650�749", count: 0 },
      { name: "750+", count: 0 },
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
    console.error("getScoreMix Error:", err);
    res.status(500).json({ success: false, message: "Could not fetch score mix" });
  }
};

// GET /api/admin/overview/top-partners?limit=5
exports.getTopPartners = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "5", 10), 20);
    const [crAgg, aiAgg, spendAgg] = await Promise.all([
      CreditReport.aggregate([
        { $match: { status: "Success" } },
        { $group: { _id: "$userId", count: { $sum: 1 } } },
        { $sort: { count: -1 } }, { $limit: 50 },
      ]),
      AIAnalysis.aggregate([
        { $match: { status: "completed" } },
        { $group: { _id: "$userId", count: { $sum: 1 } } },
        { $sort: { count: -1 } }, { $limit: 50 },
      ]),
      Transaction.aggregate([
        { $match: { type: "DEBIT", status: "SUCCESS" } },
        { $group: { _id: "$userId", total: { $sum: "$totalAmount" } } },
      ]),
    ]);
    const totals = {};
    [...crAgg, ...aiAgg].forEach((r) => {
      const k = String(r._id);
      totals[k] = (totals[k] || 0) + r.count;
    });
    const spendMap = Object.fromEntries(spendAgg.map((r) => [String(r._id), r.total]));
    const topIds = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, limit);
    const users = await User.find({ _id: { $in: topIds.map(([id]) => id) } }).select("name email activePlan").lean();
    const uMap = Object.fromEntries(users.map((u) => [String(u._id), u]));
    // Merge duplicate display names (e.g. several deleted partners -> "Unknown")
    const merged = new Map();
    topIds.forEach(([id, count]) => {
      const u = uMap[id];
      const name = u?.name || u?.email || "Unknown";
      const prev = merged.get(name) || { name, reports: 0, spent: 0, tier: u?.activePlan || null };
      prev.reports += count;
      prev.spent += spendMap[id] || 0;
      merged.set(name, prev);
    });
    const data = [...merged.values()].sort((a, b) => b.reports - a.reports).slice(0, limit);
    res.json({ success: true, data });
  } catch (err) {
    console.error("getTopPartners Error:", err);
    res.status(500).json({ success: false, message: "Could not fetch top partners" });
  }
};

// GET /api/admin/overview/recent � latest pulls (with tier + charge) + tickets + low wallets
exports.getRecentActivity = async (req, res) => {
  try {
    const pricing = await Pricing.findOne({ key: "default" }).select("lowBalanceThreshold").lean();
    const lowAt = pricing?.lowBalanceThreshold ?? 500;
    const [recentCr, recentAi, recentTickets, lowWallets] = await Promise.all([
      CreditReport.find({}).sort({ createdAt: -1 }).limit(8)
        .populate("userId", "name email activePlan").select("bureau score status createdAt userId name").lean(),
      AIAnalysis.find({}).sort({ createdAt: -1 }).limit(8)
        .populate("userId", "name email activePlan").select("status createdAt userId fileName result.score").lean(),
      Ticket.find({}).sort({ createdAt: -1 }).limit(3)
        .populate("partnerId", "name email").select("category status createdAt partnerId").lean(),
      User.find({ role: { $ne: "admin" }, walletBalance: { $lt: lowAt } })
        .sort({ walletBalance: 1 }).limit(5).select("name email walletBalance activePlan").lean(),
    ]);
    const chargeMap = {};
    const ids = [...recentCr.map((r) => r._id), ...recentAi.map((r) => r._id)];
    if (ids.length > 0) {
      const charges = await Transaction.find({ reportId: { $in: ids }, purpose: { $in: ["REPORT_CHARGE", "REPORT_FAIL_CHARGE"] } })
        .select("reportId totalAmount purpose").lean();
      charges.forEach((c) => { chargeMap[String(c.reportId)] = c; });
    }
    const pulls = [
      ...recentCr.map((r) => ({
        id: r._id, type: "Credit Report", customer: r.name || "�",
        partner: r.userId?.name || r.userId?.email || "Unknown",
        tier: r.userId?.activePlan || null,
        bureau: r.bureau || "�", score: r.score ?? "�",
        status: r.status, charge: chargeMap[String(r._id)]?.totalAmount ?? null,
        createdAt: r.createdAt,
      })),
      ...recentAi.map((r) => ({
        id: r._id, type: "AI Analysis", customer: (r.fileName || "").replace(/\.[^/.]+$/, "") || "�",
        partner: r.userId?.name || r.userId?.email || "Unknown",
        tier: r.userId?.activePlan || null,
        bureau: "AI", score: r.result?.score ?? "�",
        status: r.status === "completed" ? "Success" : r.status,
        charge: chargeMap[String(r._id)]?.totalAmount ?? null,
        createdAt: r.createdAt,
      })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8);

    res.json({ success: true, data: { pulls, recentTickets, lowWallets } });
  } catch (err) {
    console.error("getRecentActivity Error:", err);
    res.status(500).json({ success: false, message: "Could not fetch recent activity" });
  }
};

// GET /api/admin/transactions � full money ledger with filters + summary.
// Query: page, limit, startDate, endDate, type, status, purpose, tier, partnerSearch
exports.getAllTransactions = async (req, res) => {
  try {
    const { page = 1, limit = 50, startDate, endDate, type, status, purpose, tier, partnerSearch } = req.query;

    const query = {};
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }
    if (type && type !== "All") query.type = type.toUpperCase();
    if (status && status !== "All") query.status = status.toUpperCase();
    if (purpose && purpose !== "All") query.purpose = purpose;
    if (tier && tier !== "All") query.planTier = tier.toLowerCase();

    if (partnerSearch) {
      const userIds = await getUserIdFilter(partnerSearch);
      query.userId = { $in: userIds };
    }

    const [total, rows, sums] = await Promise.all([
      Transaction.countDocuments(query),
      Transaction.find(query)
        .populate("userId", "name email activePlan")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .select("-signature")
        .lean(),
      Transaction.aggregate([
        { $match: query },
        {
          $group: {
            _id: null,
            credited: {
              $sum: { $cond: [{ $and: [{ $eq: ["$type", "CREDIT"] }, { $eq: ["$status", "SUCCESS"] }] }, "$amount", 0] },
            },
            debited: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ["$type", "DEBIT"] }, { $eq: ["$status", "SUCCESS"] }] },
                  { $ifNull: ["$totalAmount", { $ifNull: ["$amount", 0] }] },
                  0,
                ],
              },
            },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const s = sums.length > 0 ? sums[0] : { credited: 0, debited: 0, count: 0 };
    res.json({
      success: true,
      data: rows,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit),
      summary: { credited: s.credited, debited: s.debited, net: s.credited - s.debited, count: s.count },
    });
  } catch (err) {
    console.error("getAllTransactions Admin Error:", err);
    res.status(500).json({ success: false, message: "Could not fetch transactions" });
  }
};
