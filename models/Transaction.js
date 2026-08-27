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

    paymentId: {
      type: String,
      default: null,
    },

    amount: {
      type: Number,
      required: true,
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
      enum: ["ADD_FUNDS", "PACKAGE_PURCHASE", "REFUND"],
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
    purpose: {
      type: String,
      enum: ["WALLET_RECHARGE", "PACKAGE_PURCHASE"],
      required: true,
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

module.exports = mongoose.model("Transaction", transactionSchema);
