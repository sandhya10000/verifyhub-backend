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
    // charged twice (recharge rows leave this null; the sparse index
    // allows unlimited nulls).
    reportId: {
      type: mongoose.Schema.Types.ObjectId,
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
      enum: ["WALLET_RECHARGE", "PACKAGE_PURCHASE", "ADD_FUNDS", "REFUND", "REPORT_CHARGE", "REPORT_FAIL_CHARGE"],
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
