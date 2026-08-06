const mongoose = require('mongoose');

const AIAnalysisSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    fileName: { type: String, required: true },
    filePath: { type: String, required: true },
    fileType: { type: String, enum: ['pdf', 'json'], required: true },
    status: {
      type: String,
      enum: ['uploaded', 'processing', 'completed', 'failed'],
      default: 'uploaded',
      index: true,
    },
    errorMessage: { type: String, default: null },
    debugError: { type: String, default: null },   // full error detail, only exposed in non-prod
    result: {
      score: { type: Number },
      scoreBand: { type: String },
      activeLoans: { type: Number },
      overdueStatus: { type: String },
      enquiries6m: { type: Number },
      enquiriesRating: { type: String },
      foirPercent: { type: Number },
      foirRating: { type: String },
      maxEligibleAmount: { type: Number },
      recommendation: { type: String },
    },
    resultPdfPath: { type: String, default: null },
    rawModelResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    // Full 8-section HTML report — generated lazily on first Download/Save action
    htmlReport:      { type: String,  default: null },
    htmlGenerating:  { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AIAnalysis', AIAnalysisSchema);
