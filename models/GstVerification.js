const mongoose = require("mongoose");

const gstVerificationSchema = new mongoose.Schema(
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

    gstin: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true,
    },

    legalName: {
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
      default: "gstin-authentication-advanced-dt",
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

    gstData: {
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
  },
  {
    timestamps: true,
  },
);

gstVerificationSchema.index({ status: 1, createdAt: -1 });
gstVerificationSchema.index({ userId: 1, status: 1 });

// Auto-fill failure fields on save — same behavior as other verifications.
gstVerificationSchema.pre("save", function () {
  if (this.status === "Failed") {
    if (!this.failedAt) this.failedAt = new Date();
    if (!this.failureReason) {
      try {
        const { classifyFailure } = require("../utils/failureReason");
        const errPayload = this.gstData?.error ?? this.gstData ?? null;
        const c = classifyFailure(errPayload);
        this.failureReason = c.failureReason;
        if (!this.failureCategory) this.failureCategory = c.failureCategory;
        if (!this.errorCode) this.errorCode = c.errorCode;
      } catch {
        if (!this.failureReason) this.failureReason = "GST verification failed";
        if (!this.failureCategory) this.failureCategory = "UNKNOWN";
      }
    }
  }
});

module.exports = mongoose.model("GstVerification", gstVerificationSchema);
