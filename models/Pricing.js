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

// Single-document pricing config.
//
// Plans are FREE eligibility tiers, not purchases: `recharge` is the minimum
// wallet balance required to SELECT the tier (nothing is ever deducted for
// the plan itself). Success charges are tiered: the partner's activePlan
// picks the row, the product picks the column — deducted per report pull.
// Tier numbers are GST-inclusive totals (gstRate 0) unless the founder says
// otherwise.
// AI + failure fallbacks stay flat across all tiers:
//   AI success = base + GST, any other failure = otherFailedCharge.
// Single-plan launch mode: one effective plan ("starter") with founder prices.
// All 5 tier rows are kept identical so stale activePlan values still bill
// correctly. Flip SINGLE_PLAN_MODE to false to restore multi-tier slabs.
// TODO(multi-plan-restore): restore tiered recharge/cibil/experian/crif/equifax values.
const SINGLE_PLAN_MODE = true;
const SINGLE_PLAN_KEY = "starter";
const SINGLE_PLAN_ROW = { recharge: 1000, cibil: 60, experian: 40, crif: 50, equifax: 40, cibilFailed: 60 };

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
    ai: { type: productPriceSchema, default: { base: 100, gstRate: 18 } },
    rc: { type: productPriceSchema, default: { base: 10, gstRate: 0 } },
    gst: { type: productPriceSchema, default: { base: 10, gstRate: 0 } },
    otherFailedCharge: { type: productPriceSchema, default: { base: 30, gstRate: 0 } },
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
    if (kind === "fail") return totalsFor(pricing.otherFailedCharge.base, pricing.otherFailedCharge.gstRate);
    return totalsFor(pricing.ai.base, pricing.ai.gstRate);
  }
  if (key === "rc") {
    // Flat ₹10 any tier; failures currently free (fail-fee deferred).
    if (kind === "fail") return totalsFor(0, 0);
    const rc = pricing.rc || { base: 10, gstRate: 0 };
    return totalsFor(rc.base, rc.gstRate);
  }
  if (key === "gst") {
    // Flat ₹10 any tier; failures currently free (fail-fee deferred).
    if (kind === "fail") return totalsFor(0, 0);
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
module.exports.quoteForProduct = quoteForProduct;
module.exports.SINGLE_PLAN_MODE = SINGLE_PLAN_MODE;
module.exports.SINGLE_PLAN_KEY = SINGLE_PLAN_KEY;
module.exports.SINGLE_PLAN_ROW = SINGLE_PLAN_ROW;
