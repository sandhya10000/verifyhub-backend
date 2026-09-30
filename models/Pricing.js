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
const pricingSchema = new mongoose.Schema(
  {
    key: { type: String, default: "default", unique: true },
    plans: {
      startup: {
        type: tierPricesSchema,
        default: { recharge: 200, cibil: 120, experian: 95, crif: 95, equifax: 85, cibilFailed: 90 },
      },
      starter: {
        type: tierPricesSchema,
        default: { recharge: 1000, cibil: 110, experian: 85, crif: 85, equifax: 80, cibilFailed: 80 },
      },
      growth: {
        type: tierPricesSchema,
        default: { recharge: 5000, cibil: 90, experian: 65, crif: 65, equifax: 60, cibilFailed: 70 },
      },
      pro: {
        type: tierPricesSchema,
        default: { recharge: 10000, cibil: 80, experian: 50, crif: 55, equifax: 50, cibilFailed: 60 },
      },
      enterprise: {
        type: tierPricesSchema,
        default: { recharge: 25000, cibil: 65, experian: 35, crif: 45, equifax: 40, cibilFailed: 50 },
      },
    },
    ai: { type: productPriceSchema, default: { base: 100, gstRate: 18 } },
    otherFailedCharge: { type: productPriceSchema, default: { base: 30, gstRate: 0 } },
    minRecharge: { type: Number, default: 200, min: 0 },
    lowBalanceThreshold: { type: Number, default: 500, min: 0 },
    lowBalanceAlertIntervalDays: { type: Number, default: 7, min: 1 },
  },
  { timestamps: true },
);

const PLAN_KEYS = ["startup", "starter", "growth", "pro", "enterprise"];
const PRODUCT_KEYS = ["ai", "cibil", "crif", "experian", "equifax"];

// Recharge amount -> plan tier (floor-mapped, sticky upgrades).
// Amounts below the cheapest plan return null (rejected upstream).
function tierForAmount(amount) {
  const amt = Number(amount) || 0;
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
  if (["cibil", "crif", "experian", "equifax"].includes(key)) {
    if (kind === "fail") {
      if (key === "cibil") {
        const row = pricing.plans[plan];
        return totalsFor(row.cibilFailed, 0);
      }
      return totalsFor(pricing.otherFailedCharge.base, pricing.otherFailedCharge.gstRate);
    }
    const row = pricing.plans[plan];
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
