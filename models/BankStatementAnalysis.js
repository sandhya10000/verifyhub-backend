const mongoose = require("mongoose");

// Bank Statement Analyzer (Finpass). One document per uploaded statement.
// The rebranded report is stored outside the public /uploads tree and served
// only through the owner-checked /api/bsa/:id/report endpoint.
const bankStatementAnalysisSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    orderId: { type: String, default: null },

    fileName: { type: String, default: null },

    // Finpass identifiers returned by the upload call.
    clientId: { type: String, default: null, index: true },
    docId: { type: String, default: null },

    status: {
      type: String,
      // Finalizing = one poll has claimed the result and is downloading/branding it.
      enum: ["Processing", "Finalizing", "Success", "Failed"],
      default: "Processing",
      index: true,
    },

    // Our rebranded PDF (private path, served via the owner-checked endpoint).
    localPath: { type: String, default: null },

    accountHolderName: { type: String, default: null },
    bankName: { type: String, default: null },
    accountNumberMasked: { type: String, default: null },
    statementFrom: { type: String, default: null },
    statementTo: { type: String, default: null },
    pageCount: { type: Number, default: null },

    // Trimmed Finpass payload: account info and status only. Transactions and
    // signed S3 links are not stored.
    bsaData: { type: mongoose.Schema.Types.Mixed, default: null },

    failureReason: { type: String, default: null },
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
        null,
      ],
      default: null,
    },
    errorCode: { type: String, default: null },
    failedAt: { type: Date, default: null },

    sheetSyncedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

bankStatementAnalysisSchema.index({ userId: 1, status: 1 });
bankStatementAnalysisSchema.index({ status: 1, createdAt: -1 });
bankStatementAnalysisSchema.index({ sheetSyncedAt: 1, createdAt: 1 });

module.exports = mongoose.model("BankStatementAnalysis", bankStatementAnalysisSchema);
