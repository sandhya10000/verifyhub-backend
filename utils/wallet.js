const User = require("../models/User");
const Transaction = require("../models/Transaction");
const Pricing = require("../models/Pricing");
const { PRODUCT_KEYS, totalsFor } = require("../models/Pricing");

let cachedPricing = null;
let cachedAt = 0;
const CACHE_MS = 60 * 1000;

async function getPricing() {
  const now = Date.now();
  if (cachedPricing && now - cachedAt < CACHE_MS) return cachedPricing;
  cachedPricing =
    (await Pricing.findOne({ key: "default" }).lean()) ||
    {
      ai: { base: 100, gstRate: 18 },
      cibil: { base: 50, gstRate: 18 },
      crif: { base: 50, gstRate: 18 },
      experian: { base: 50, gstRate: 18 },
      equifax: { base: 50, gstRate: 18 },
      minRecharge: 100,
      lowBalanceThreshold: 500,
    };
  cachedAt = now;
  return cachedPricing;
}

function resetPricingCache() {
  cachedPricing = null;
  cachedAt = 0;
}

// Effective charge for a product: { base, gstRate, gstAmount, total }
async function quoteFor(productKey) {
  const pricing = await getPricing();
  const key = String(productKey || "").toLowerCase();
  if (!PRODUCT_KEYS.includes(key)) throw new Error(`Unknown product: ${productKey}`);
  return totalsFor(pricing[key]);
}

// Pre-check: can this user afford one pull of this product right now?
async function canAfford(userId, productKey) {
  const { total } = await quoteFor(productKey);
  const user = await User.findById(userId).select("walletBalance").lean();
  if (!user) return { ok: false, reason: "user-not-found", total, balance: 0 };
  if ((user.walletBalance || 0) < total) {
    return { ok: false, reason: "insufficient", total, balance: user.walletBalance || 0 };
  }
  return { ok: true, total, balance: user.walletBalance };
}

// Charge one successful report. Idempotent per reportId; balance can
// never go negative thanks to the $gte guard (safe under double
// submits and parallel pulls).
async function chargeForReport(userId, reportId, productKey, bureau) {
  const { base, gstRate, gstAmount, total } = await quoteFor(productKey);

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
      purpose: "REPORT_CHARGE",
      status: "SUCCESS",
      gateway: "WALLET",
      description: `${String(productKey).toUpperCase()} report charge${bureau ? ` (${bureau})` : ""}`,
    });
  } catch (err) {
    if (err && err.code === 11000) {
      // Lost a race with a parallel charge for the same report.
      // Money was already deducted once — refund this second debit.
      await User.updateOne({ _id: userId }, { $inc: { walletBalance: total } });
      const user = await User.findById(userId).select("walletBalance").lean();
      return { ok: true, duplicate: true, total, balance: user?.walletBalance ?? null };
    }
    // Ledger write failed AFTER the debit — do not hide it. The money
    // moved, so surface loudly for manual reconciliation.
    console.error("[wallet] DEBIT applied but ledger write failed:", {
      userId: String(userId), reportId: String(reportId), productKey, total, error: err?.message,
    });
    throw err;
  }

  const user = await User.findById(userId).select("walletBalance").lean();
  return { ok: true, total, base, gstAmount, balance: user?.walletBalance ?? null };
}

module.exports = { getPricing, resetPricingCache, quoteFor, canAfford, chargeForReport };
