const mongoose = require("mongoose");

const creditReportSchema = new mongoose.Schema(
  {
    // =========================
    // CUSTOMER DETAILS
    // =========================
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    orderId: {
      type: String,
      index: true,
    },

    // =========================
    // CRIF REFERENCES
    // =========================
    reportId: {
      type: String,
      index: true,
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

    gender: {
      type: String,
      enum: ["Male", "Female", "Other"],
    },

    // =========================
    // REPORT DETAILS
    // =========================
    reportType: {
      type: String,
      default: "CIBIL",
      trim: true,
    },

    consent: {
      type: String,
      enum: ["Y", "N"],
      default: "Y",
    },

    bureau: {
      type: String,
      enum: ["CIBIL", "CRIF", "EXPERIAN", "EQUIFAX"],
      default: "CIBIL",
      uppercase: true,
    },

    // =========================
    // CREDIT SCORE
    // =========================
    score: {
      type: Number,
      min: 0,
      max: 999,
      default: null,
    },

    rating: {
      type: String,
      default: null,
      trim: true,
    },

    // =========================
    // REPORT STATUS
    // =========================
    status: {
      type: String,
      enum: ["Pending", "Success", "Failed"],
      default: "Pending",
    },

    // =========================
    // REPORT URL
    // =========================
    reportUrl: {
      type: String,
      default: null,
    },

    // =========================
    // COMPLETE API RESPONSE
    // =========================
    reportData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    localPath: {
      type: String,
    },
    isPublic: {
      type: Boolean,
      default: false,
    },

    // =========================
    // REMARKS
    // =========================
    remarks: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("CreditReport", creditReportSchema);
