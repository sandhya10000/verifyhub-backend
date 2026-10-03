const User = require("../models/User");
const Transaction = require("../models/Transaction");
const Pricing = require("../models/Pricing");
const { PLAN_KEYS, quoteForProduct } = require("../models/Pricing");

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

async function applyDebit(userId, reportId, productLabel, quote, purpose, tier) {
  const { base, gstAmount, total } = quote;

  // Already charged? Treat as success without double-charging.
  const existing = await Transaction.findOne({ reportId }).select("_id").lean();
  if (existing) {
    const user = await User.findById(userId).select("walletBalance").lean();
    return { ok: true, duplicate: true, total, balance: user?.walletBalance ?? null };
  }

  const debit = await User.updateOne(
    { _id: userId, walletBalance: { $gte: total } },
    { $inc: { walletBalance: -total } },
  );
  if (debit.modifiedCount === 0) {
    const user = await User.findById(userId).select("walletBalance").lean();
    return { ok: false, reason: user ? "insufficient" : "user-not-found", total, balance: user?.walletBalance ?? 0 };
  }

  try {
    await Transaction.create({
      userId,
      orderId: `chg_${String(reportId)}`,
      reportId,
      amount: base,
      gstAmount,
      totalAmount: total,
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
      // refund this second debit.
      await User.updateOne({ _id: userId }, { $inc: { walletBalance: total } });
      const user = await User.findById(userId).select("walletBalance").lean();
      return { ok: true, duplicate: true, total, balance: user?.walletBalance ?? null };
    }
    console.error("[wallet] DEBIT applied but ledger write failed:", {
      userId: String(userId), reportId: String(reportId), productLabel, total, error: err?.message,
    });
    throw err;
  }

  const user = await User.findById(userId).select("walletBalance").lean();
  return { ok: true, total, base, gstAmount, balance: user?.walletBalance ?? null };
}

// Charge one successful report. Idempotent per reportId; balance can
// never go negative thanks to the $gte guard.
async function chargeForReport(userId, reportId, productKey, bureau) {
  const { tier } = await userTier(userId);
  const quote = await quoteFor(productKey, tier, "success");
  return applyDebit(
    userId, reportId,
    `${String(productKey).toUpperCase()} report charge${bureau ? ` (${bureau})` : ""} · ${tier} plan`,
    quote, "REPORT_CHARGE", tier,
  );
}

// Charge a failed pull.
// Single-plan launch: every failed bureau pull bills the SAME as success
// (no free matched-input retry, no 30 flat fallback for bureaus).
//  - AI: flat otherFailedCharge (unchanged).
//  - RC/GST fails: still free (unchanged).
// TODO(multi-plan-restore): restore CIBIL matched-free + cibilFailed/30 fallback.
async function chargeFailedReport(userId, reportId, productKey, bureau, mismatched = true) {
  const key = String(productKey || "").toLowerCase();
  const { SINGLE_PLAN_MODE } = require("../models/Pricing");
  if (key === "cibil" && !mismatched && !SINGLE_PLAN_MODE) {
    return { ok: true, free: true, total: 0 };
  }
  const { tier } = await userTier(userId);
  const quote = await quoteFor(key, tier, "fail");
  return applyDebit(
    userId, reportId,
    `${String(productKey).toUpperCase()} failed-report charge${bureau ? ` (${bureau})` : ""} · ${tier} plan`,
    quote, "REPORT_FAIL_CHARGE", tier,
  );
}

module.exports = { getPricing, resetPricingCache, quoteFor, canAfford, chargeForReport, chargeFailedReport, userTier };
