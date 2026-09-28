const mongoose = require("mongoose");

const productPriceSchema = new mongoose.Schema(
  {
    base: { type: Number, required: true, min: 0 },
    gstRate: { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false },
);

// Single-document pricing config. Effective charge per product:
//   total = base + (base * gstRate / 100)
// Historical ledger rows keep the values they were charged at —
// price edits apply to new pulls only.
const pricingSchema = new mongoose.Schema(
  {
    key: { type: String, default: "default", unique: true },
    ai: { type: productPriceSchema, default: { base: 100, gstRate: 18 } },
    cibil: { type: productPriceSchema, default: { base: 50, gstRate: 18 } },
    crif: { type: productPriceSchema, default: { base: 50, gstRate: 18 } },
    experian: { type: productPriceSchema, default: { base: 50, gstRate: 18 } },
    equifax: { type: productPriceSchema, default: { base: 50, gstRate: 18 } },
    minRecharge: { type: Number, default: 100, min: 0 },
    lowBalanceThreshold: { type: Number, default: 500, min: 0 },
  },
  { timestamps: true },
);

const PRODUCT_KEYS = ["ai", "cibil", "crif", "experian", "equifax"];

function totalsFor(product) {
  const base = Number(product.base) || 0;
  const gstRate = Number(product.gstRate) || 0;
  const gstAmount = Math.round(base * gstRate) / 100;
  const total = Math.round((base + gstAmount) * 100) / 100;
  return { base, gstRate, gstAmount, total };
}

module.exports = mongoose.models.Pricing || mongoose.model("Pricing", pricingSchema);
module.exports.PRODUCT_KEYS = PRODUCT_KEYS;
module.exports.totalsFor = totalsFor;
