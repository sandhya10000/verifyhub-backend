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
    email: {
      type: String,
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
      default: null,
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

    // =========================
    // FAILURE DETAILS (failed bureau pulls)
    // =========================
    failureReason: {
      type: String,
      default: null,
      trim: true,
    },
    failureCategory: {
      type: String,
      enum: [
        "BUREAU_REJECT",
        "VALIDATION",
        "TIMEOUT",
        "AUTH_CONFIG",
        "NETWORK",
        "EMPTY_RESPONSE",
        "UNKNOWN",
      ],
      default: null,
    },
    errorCode: {
      type: String,
      default: null,
      trim: true,
    },
    failedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

creditReportSchema.index({ status: 1, bureau: 1, createdAt: -1 });
creditReportSchema.index({ userId: 1, status: 1 });

// Auto-fill failure fields on save: new failures and legacy docs that only
// have reportData.error get a readable reason without touching controllers.
creditReportSchema.pre("save", function () {
  if (this.status === "Failed") {
    if (!this.failedAt) this.failedAt = new Date();
    if (!this.failureReason) {
      try {
        const { classifyFailure } = require("../utils/failureReason");
        const errPayload =
          this.reportData?.error ?? this.reportData ?? this.remarks ?? null;
        const c = classifyFailure(errPayload);
        this.failureReason = c.failureReason;
        if (!this.failureCategory) this.failureCategory = c.failureCategory;
        if (!this.errorCode) this.errorCode = c.errorCode;
      } catch {
        if (!this.failureReason) this.failureReason = "Bureau request failed";
        if (!this.failureCategory) this.failureCategory = "UNKNOWN";
      }
    }
  }
});

module.exports = mongoose.model("CreditReport", creditReportSchema);
