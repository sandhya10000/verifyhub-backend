const mongoose = require("mongoose");

const creditReportSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    mobile: {
      type: String,
      required: true,
      trim: true,
    },

    pan: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },

    consent: {
      type: String,
      enum: ["Y", "N"],
      default: "Y",
    },

    score: {
      type: Number,
      min: 0,
      max: 999,
    },

    bureau: {
      type: String,
      enum: ["CIBIL", "CRIF", "EXPERIAN", "EQUIFAX"],
      default: "CIBIL",
    },

    status: {
      type: String,
      enum: ["Pending", "Success", "Failed"],
      default: "Pending",
    },

    reportUrl: {
      type: String,
    },

    reportData: {
      type: mongoose.Schema.Types.Mixed,
    },

    remarks: {
      type: String,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("CreditReport", creditReportSchema);
