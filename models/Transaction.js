const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    orderId: {
      type: String,
      required: true,
      unique: true,
    },

    // Set on report-charge debits — unique so a report can never be
    // charged twice. NO default: the field must stay ABSENT (not null)
    // on recharge rows, because even sparse indexes reject duplicate
    // explicit nulls. Only debits set this field.
    reportId: {
      type: mongoose.Schema.Types.ObjectId,
    },

    // Pricing tier active at transaction time (recharges: tier purchased;
    // debits: tier charged at). Powers per-tier revenue reporting.
    planTier: {
      type: String,
      enum: ["startup", "starter", "growth", "pro", "enterprise"],
      default: null,
    },

    // Plan chosen at order creation (recharges only). Verify re-reads this
    // so the paid plan survives even if pricing changes mid-checkout.
    planSelected: {
      type: String,
      default: null,
    },

    // Plan fee locked at order time (recharges only). Verify honors this
    // instead of re-reading live pricing, so a mid-checkout reprice can
    // neither strand paid money nor grant a below-price plan.
    planFee: {
      type: Number,
      default: null,
    },

    paymentId: {
      type: String,
      default: null,
    },

    amount: {
      type: Number,
      required: true,
    },

    // GST split (ex-GST value in `amount`; total = amount + gstAmount)
    gstAmount: {
      type: Number,
      default: 0,
    },

    totalAmount: {
      type: Number,
      default: null,
    },

    currency: {
      type: String,
      default: "INR",
    },

    type: {
      type: String,
      enum: ["CREDIT", "DEBIT"],
      required: true,
    },

    purpose: {
      type: String,
      enum: ["WALLET_RECHARGE", "PACKAGE_PURCHASE", "ADD_FUNDS", "DEDUCT_FUNDS", "REFUND", "REPORT_CHARGE", "REPORT_FAIL_CHARGE", "PLAN_PURCHASE", "CUSTOM_BRAND_FEE"],
      required: true,
    },

    status: {
      type: String,
      enum: ["PENDING", "SUCCESS", "FAILED", "REFUNDED"],
      default: "PENDING",
    },

    gateway: {
      type: String,
      default: "RAZORPAY",
    },

    signature: {
      type: String,
      default: null,
    },

    description: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

transactionSchema.index({ reportId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Transaction", transactionSchema);
