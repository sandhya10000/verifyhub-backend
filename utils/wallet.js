const User = require("../models/User");
const Transaction = require("../models/Transaction");
const Pricing = require("../models/Pricing");
const { PLAN_KEYS, quoteForProduct } = require("../models/Pricing");
const PointsLedger = require("../models/PointsLedger");
const { POINTS_PER_RUPEE_REDEEM } = require("./points");

let cachedPricing = null;
let cachedAt = 0;
const CACHE_MS = 60 * 1000;

async function getPricing() {
  const now = Date.now();
  if (cachedPricing && now - cachedAt < CACHE_MS) return cachedPricing;
  cachedPricing = (await Pricing.findOne({ key: "default" }).lean()) || null;
  cachedAt = now;
  return cachedPricing;
}

function resetPricingCache() {
  cachedPricing = null;
  cachedAt = 0;
}

async function userTier(userId) {
  const user = await User.findById(userId).select("activePlan walletBalance").lean();
  const tier = user && PLAN_KEYS.includes(user.activePlan) ? user.activePlan : "starter";
  return { user, tier };
}

// Effective charge for a product + tier + outcome.
// kind: 'success' | 'fail'
async function quoteFor(productKey, tier = "starter", kind = "success") {
  const pricing = await getPricing();
  if (!pricing) throw new Error("Pricing config missing");
  if (!pricing.plans || !pricing.ai || !pricing.otherFailedCharge) {
    throw new Error("Pricing config incomplete (pre-v2 doc) — restart backend to auto-migrate");
  }
  return quoteForProduct(pricing, productKey, tier, kind);
}

// Pre-check: can this user afford one pull of this product right now?
// Tier is read from the user's activePlan (defaults to starter).
async function canAfford(userId, productKey) {
  const { user, tier } = await userTier(userId);
  if (!user) return { ok: false, reason: "user-not-found", total: 0, balance: 0, tier };
  const { total } = await quoteFor(productKey, tier, "success");
  if ((user.walletBalance || 0) < total) {
    return { ok: false, reason: "insufficient", total, balance: user.walletBalance || 0, tier };
  }
  return { ok: true, total, balance: user.walletBalance, tier };
}

// pointsToRedeem (optional): credit points applied to this charge. Each point
// is worth Rs 0.10 (10 points = Rs 1). Rupees and points are debited in one
// atomic update, so a charge can never take points without the rupee part.
async function applyDebit(userId, reportId, productLabel, quote, purpose, tier, pointsToRedeem = 0) {
  const { base, gstAmount, total } = quote;

  // Already charged? Treat as success without double-charging.
  const existing = await Transaction.findOne({ reportId }).select("_id").lean();
  if (existing) {
    const user = await User.findById(userId).select("walletBalance").lean();
    return { ok: true, duplicate: true, total, balance: user?.walletBalance ?? null };
  }

  // Points can never cover more than the charge itself.
  const requestedPoints = Math.max(0, Math.floor(Number(pointsToRedeem) || 0));
  const points = Math.min(requestedPoints, Math.floor(total * POINTS_PER_RUPEE_REDEEM));
  const net = Math.round((total - points / POINTS_PER_RUPEE_REDEEM) * 100) / 100;

  // Only add the points guard and $inc when points are used. Users created
  // before creditPoints existed have no such field, so a $gte guard would
  // block every ordinary debit.
  const filter = { _id: userId, walletBalance: { $gte: net } };
  const inc = { walletBalance: -net };
  if (points > 0) {
    filter.creditPoints = { $gte: points };
    inc.creditPoints = -points;
  }

  const debit = await User.updateOne(filter, { $inc: inc });
  if (debit.modifiedCount === 0) {
    const user = await User.findById(userId).select("walletBalance").lean();
    return { ok: false, reason: user ? "insufficient" : "user-not-found", total: net, balance: user?.walletBalance ?? 0 };
  }

  const refund = async () => {
    const back = { walletBalance: net };
    if (points > 0) back.creditPoints = points;
    await User.updateOne({ _id: userId }, { $inc: back });
  };

  try {
    await Transaction.create({
      userId,
      orderId: `chg_${String(reportId)}`,
      reportId,
      amount: base,
      gstAmount,
      totalAmount: net,
      pointsRedeemed: points,
      currency: "INR",
      type: "DEBIT",
      purpose,
      status: "SUCCESS",
      gateway: "WALLET",
      planTier: tier || null,
      description: productLabel,
    });
  } catch (err) {
    if (err && err.code === 11000) {
      // Lost a race with a parallel charge for the same report —
      // refund this second debit (rupees and points).
      await refund();
      const user = await User.findById(userId).select("walletBalance").lean();
      return { ok: true, duplicate: true, total: net, balance: user?.walletBalance ?? null };
    }
    console.error("[wallet] DEBIT applied but ledger write failed:", {
      userId: String(userId), reportId: String(reportId), productLabel, total: net, error: err?.message,
    });
    throw err;
  }

  if (points > 0) {
    try {
      await PointsLedger.create({
        userId,
        type: "REDEEM",
        points,
        rupeeValue: points / POINTS_PER_RUPEE_REDEEM,
        key: `redeem_${String(reportId)}`,
        refId: String(reportId),
        description: productLabel,
      });
    } catch (err) {
      console.error("[points] redeem ledger write failed:", String(reportId), err?.message);
    }
  }

  const user = await User.findById(userId).select("walletBalance creditPoints").lean();
  return {
    ok: true,
    total: net,
    base,
    gstAmount,
    pointsRedeemed: points,
    balance: user?.walletBalance ?? null,
    creditPoints: user?.creditPoints ?? null,
  };
}

// Charge one successful report. Idempotent per reportId; balance can
// never go negative thanks to the $gte guard.
async function chargeForReport(userId, reportId, productKey, bureau, pointsToRedeem = 0) {
  const { tier } = await userTier(userId);
  const quote = await quoteFor(productKey, tier, "success");
  return applyDebit(
    userId, reportId,
    `${String(productKey).toUpperCase()} report charge${bureau ? ` (${bureau})` : ""} · ${tier} plan`,
    quote, "REPORT_CHARGE", tier, pointsToRedeem,
  );
}

// Charge a failed pull.
// Every failure is billed, regardless of status code: bureaus bill the SAME as
// success, AI bills flat ₹100 (base, no GST), RC/GST bill ₹10 (same as
// success). There is no free/failed-retry path.
async function chargeFailedReport(userId, reportId, productKey, bureau, mismatched = true) {
  const key = String(productKey || "").toLowerCase();
  const { tier } = await userTier(userId);
  const quote = await quoteFor(key, tier, "fail");
  return applyDebit(
    userId, reportId,
    `${String(productKey).toUpperCase()} failed-report charge${bureau ? ` (${bureau})` : ""} · ${tier} plan`,
    quote, "REPORT_FAIL_CHARGE", tier,
  );
}

module.exports = { getPricing, resetPricingCache, quoteFor, canAfford, chargeForReport, chargeFailedReport, userTier };
