const mongoose = require("mongoose");

const tierPricesSchema = new mongoose.Schema(
  {
    recharge: { type: Number, required: true, min: 0 },
    cibil: { type: Number, required: true, min: 0 },
    experian: { type: Number, required: true, min: 0 },
    crif: { type: Number, required: true, min: 0 },
    equifax: { type: Number, required: true, min: 0 },
    cibilFailed: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const productPriceSchema = new mongoose.Schema(
  {
    base: { type: Number, required: true, min: 0 },
    gstRate: { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false },
);

// Recharge plan: pay X via Razorpay, wallet credited Y (Y - X = bonus).
// Plans-only checkout: the amount must exactly match a plan's pay value.
const rechargePlanSchema = new mongoose.Schema(
  {
    pay: { type: Number, required: true, min: 0 },
    credit: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const DEFAULT_RECHARGE_PLANS = [
  { pay: 1000, credit: 1000 },
  { pay: 2000, credit: 2100 },
  { pay: 5000, credit: 5500 },
  { pay: 10000, credit: 12000 },
  { pay: 25000, credit: 28000 },
  { pay: 50000, credit: 60000 },
];

// Single-document pricing config.
//
// Plans are FREE eligibility tiers, not purchases: `recharge` is the minimum
// wallet balance required to SELECT the tier (nothing is ever deducted for
// the plan itself). Success charges are tiered: the partner's activePlan
// picks the row, the product picks the column — deducted per report pull.
// Tier numbers are GST-inclusive totals (gstRate 0) unless the founder says
// otherwise.
// AI + failure fallbacks stay flat across all tiers:
//   AI success = base flat (no GST), any other failure = otherFailedCharge.
// Single-plan launch mode: one effective plan ("starter") with founder prices.
// All 5 tier rows are kept identical so stale activePlan values still bill
// correctly. Flip SINGLE_PLAN_MODE to false to restore multi-tier slabs.
// TODO(multi-plan-restore): restore tiered recharge/cibil/experian/crif/equifax values.
const SINGLE_PLAN_MODE = true;
const SINGLE_PLAN_KEY = "starter";
const SINGLE_PLAN_ROW = { recharge: 1000, cibil: 60, experian: 40, crif: 50, equifax: 40, cibilFailed: 60 };

// One-time Custom Branded Report fee (₹, flat GST-inclusive). Single source of
// truth for the branded-report payment flow; mirrors Pricing.cbr.base.
const CBR_PRICE_INR = 2500;

const pricingSchema = new mongoose.Schema(
  {
    key: { type: String, default: "default", unique: true },
    plans: {
      startup: {
        type: tierPricesSchema,
        default: { recharge: 1000, cibil: 60, experian: 40, crif: 50, equifax: 40, cibilFailed: 60 },
      },
      starter: {
        type: tierPricesSchema,
        default: { recharge: 1000, cibil: 60, experian: 40, crif: 50, equifax: 40, cibilFailed: 60 },
      },
      growth: {
        type: tierPricesSchema,
        default: { recharge: 1000, cibil: 60, experian: 40, crif: 50, equifax: 40, cibilFailed: 60 },
      },
      pro: {
        type: tierPricesSchema,
        default: { recharge: 1000, cibil: 60, experian: 40, crif: 50, equifax: 40, cibilFailed: 60 },
      },
      enterprise: {
        type: tierPricesSchema,
        default: { recharge: 1000, cibil: 60, experian: 40, crif: 50, equifax: 40, cibilFailed: 60 },
      },
    },
    ai: { type: productPriceSchema, default: { base: 100, gstRate: 0 } },
    // Dedicated AI failure price (flat total — GST inputs are hidden on the
    // Admin Pricing page, so gstRate stays 0 here; totals show GST-inclusive).
    aiFail: { type: productPriceSchema, default: { base: 100, gstRate: 0 } },
    rc: { type: productPriceSchema, default: { base: 10, gstRate: 0 } },
    gst: { type: productPriceSchema, default: { base: 10, gstRate: 0 } },
    // One-time Custom Branded Report fee — flat GST-inclusive total (no split).
    cbr: { type: productPriceSchema, default: { base: 2500, gstRate: 0 } },
    otherFailedCharge: { type: productPriceSchema, default: { base: 30, gstRate: 0 } },
    // Recharge plans (pay -> wallet credit). Bonus = credit - pay.
    // Admin-editable; checkout requires an exact pay match.
    rechargePlans: { type: [rechargePlanSchema], default: DEFAULT_RECHARGE_PLANS },
    minRecharge: { type: Number, default: 1000, min: 0 },
    lowBalanceThreshold: { type: Number, default: 500, min: 0 },
    lowBalanceAlertIntervalDays: { type: Number, default: 7, min: 1 },
  },
  { timestamps: true },
);

const PLAN_KEYS = ["startup", "starter", "growth", "pro", "enterprise"];
const PRODUCT_KEYS = ["ai", "cibil", "crif", "experian", "equifax", "rc", "gst"];

// Recharge amount -> plan tier.
// Single-plan mode: any amount >= minRecharge maps to SINGLE_PLAN_KEY.
// TODO(multi-plan-restore): restore floor-mapped slabs (25000 enterprise,
// 10000 pro, 5000 growth, 1000 starter, 200 startup).
function tierForAmount(amount) {
  const amt = Number(amount) || 0;
  if (SINGLE_PLAN_MODE) {
    if (amt >= SINGLE_PLAN_ROW.recharge) return SINGLE_PLAN_KEY;
    return null;
  }
  if (amt >= 25000) return "enterprise";
  if (amt >= 10000) return "pro";
  if (amt >= 5000) return "growth";
  if (amt >= 1000) return "starter";
  if (amt >= 200) return "startup";
  return null;
}

// Wallet credit for an exact plan pay amount, or null when no plan matches.
// `plans` is the Pricing.rechargePlans array (falls back to defaults).
function creditForRecharge(amount, plans) {
  const amt = Number(amount);
  if (!Number.isFinite(amt)) return null;
  const list = Array.isArray(plans) && plans.length ? plans : DEFAULT_RECHARGE_PLANS;
  const hit = list.find((p) => Number(p.pay) === amt);
  return hit ? Number(hit.credit) : null;
}

function totalsFor(base, gstRate) {
  const b = Number(base) || 0;
  const g = Number(gstRate) || 0;
  const gstAmount = Math.round(b * g) / 100;
  const total = Math.round((b + gstAmount) * 100) / 100;
  return { base: b, gstRate: g, gstAmount, total };
}

// Effective charge for a product + tier + outcome.
// kind: 'success' | 'fail'. Non-CIBIL/AI failures always use the flat fallback.
function quoteForProduct(pricing, productKey, tier, kind = "success") {
  const key = String(productKey || "").toLowerCase();
  const plan = PLAN_KEYS.includes(tier) ? tier : "starter";
  if (key === "ai") {
    // Single-plan launch: AI failure bills the dedicated aiFail flat price
    // (admin-editable, no GST shown anywhere).
    // TODO(multi-plan-restore): restore otherFailedCharge fallback below.
    if (kind === "fail") {
      if (SINGLE_PLAN_MODE) {
        const aiFail = pricing.aiFail || { base: pricing.ai.base, gstRate: 0 };
        return totalsFor(aiFail.base, 0);
      }
      return totalsFor(pricing.otherFailedCharge.base, pricing.otherFailedCharge.gstRate);
    }
    // AI success is flat — GST removed per founder: base 100 = charge 100.
    return totalsFor(pricing.ai.base, 0);
  }
  if (key === "rc") {
    // Failures bill the same ₹10 as success — permanently, in every mode.
    const rc = pricing.rc || { base: 10, gstRate: 0 };
    return totalsFor(rc.base, rc.gstRate);
  }
  if (key === "gst") {
    // Failures bill the same ₹10 as success — permanently, in every mode.
    const gst = pricing.gst || { base: 10, gstRate: 0 };
    return totalsFor(gst.base, gst.gstRate);
  }
  if (["cibil", "crif", "experian", "equifax"].includes(key)) {
    if (kind === "fail") {
      // Single-plan launch: failed bureau pulls bill the SAME as success
      // (cibil 60 / experian 40 / crif 50 / equifax 40).
      // TODO(multi-plan-restore): restore tiered fail pricing (cibilFailed row + 30 flat fallback).
      if (SINGLE_PLAN_MODE) {
        const row = pricing.plans[plan] || pricing.plans[SINGLE_PLAN_KEY] || pricing.plans.starter;
        return totalsFor(row[key], 0);
      }
      if (key === "cibil") {
        const row = pricing.plans[plan] || pricing.plans[SINGLE_PLAN_KEY] || pricing.plans.starter;
        return totalsFor(row.cibilFailed, 0);
      }
      return totalsFor(pricing.otherFailedCharge.base, pricing.otherFailedCharge.gstRate);
    }
    const row = pricing.plans[plan] || pricing.plans[SINGLE_PLAN_KEY] || pricing.plans.starter;
    return totalsFor(row[key], 0);
  }
  throw new Error(`Unknown product: ${productKey}`);
}

module.exports = mongoose.models.Pricing || mongoose.model("Pricing", pricingSchema);
module.exports.PLAN_KEYS = PLAN_KEYS;
module.exports.PRODUCT_KEYS = PRODUCT_KEYS;
module.exports.tierForAmount = tierForAmount;
module.exports.totalsFor = totalsFor;
module.exports.creditForRecharge = creditForRecharge;
module.exports.DEFAULT_RECHARGE_PLANS = DEFAULT_RECHARGE_PLANS;
module.exports.quoteForProduct = quoteForProduct;
module.exports.SINGLE_PLAN_MODE = SINGLE_PLAN_MODE;
module.exports.SINGLE_PLAN_KEY = SINGLE_PLAN_KEY;
module.exports.SINGLE_PLAN_ROW = SINGLE_PLAN_ROW;
module.exports.CBR_PRICE_INR = CBR_PRICE_INR;
