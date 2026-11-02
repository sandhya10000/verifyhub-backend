const mongoose = require("mongoose");

// Credit points ledger. Kept separate from Transaction so rupee totals in
// dashboards and admin reports never include points rows.
const pointsLedgerSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    type: {
      type: String,
      enum: ["EARN", "REDEEM", "REVERSAL"],
      required: true,
    },

    points: {
      type: Number,
      required: true,
    },

    // Rupee value of the points (points / 10 for redemption, 1:1 for earning).
    rupeeValue: {
      type: Number,
      default: 0,
    },

    // Deterministic idempotency key, e.g. "earn_<orderId>", "redeem_<reportId>".
    key: {
      type: String,
      required: true,
      unique: true,
    },

    refId: {
      type: String,
      default: null,
    },

    balanceAfter: {
      type: Number,
      default: null,
    },

    description: {
      type: String,
      default: "",
    },
  },
  { timestamps: true },
);

pointsLedgerSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("PointsLedger", pointsLedgerSchema);
