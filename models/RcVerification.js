const mongoose = require("mongoose");

const rcVerificationSchema = new mongoose.Schema(
  {
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

    vehicleNumber: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true,
    },

    ownerName: {
      type: String,
      default: null,
      trim: true,
    },

    consent: {
      type: String,
      enum: ["Y", "N"],
      default: "Y",
    },

    documentType: {
      type: String,
      default: "vehicle-rc-verification-dt",
      trim: true,
    },

    status: {
      type: String,
      enum: ["Pending", "Success", "Failed"],
      default: "Pending",
    },

    reportUrl: {
      type: String,
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

    rcData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // =========================
    // FAILURE DETAILS
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
    // Google Sheets export watermark (set by the scheduled sync job).
    sheetSyncedAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

rcVerificationSchema.index({ status: 1, createdAt: -1 });
rcVerificationSchema.index({ userId: 1, status: 1 });

// Auto-fill failure fields on save — same behavior as CreditReport.
rcVerificationSchema.pre("save", function () {
  if (this.status === "Failed") {
    if (!this.failedAt) this.failedAt = new Date();
    if (!this.failureReason) {
      try {
        const { classifyFailure } = require("../utils/failureReason");
        const errPayload = this.rcData?.error ?? this.rcData ?? null;
        const c = classifyFailure(errPayload);
        this.failureReason = c.failureReason;
        if (!this.failureCategory) this.failureCategory = c.failureCategory;
        if (!this.errorCode) this.errorCode = c.errorCode;
      } catch {
        if (!this.failureReason) this.failureReason = "RC verification failed";
        if (!this.failureCategory) this.failureCategory = "UNKNOWN";
      }
    }
  }
});

module.exports = mongoose.model("RcVerification", rcVerificationSchema);
