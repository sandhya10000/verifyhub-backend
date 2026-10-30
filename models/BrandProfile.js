const mongoose = require('mongoose');

const BrandProfileSchema = new mongoose.Schema(
  {
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    partnerCode: {
      type: String,
      required: true,
      index: true,
    },
    version: {
      type: Number,
      required: true,
      default: 1,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    firmName: {
      type: String,
      required: true,
      trim: true,
    },
    tagline: {
      type: String,
      default: '',
      trim: true,
    },
    logo: {
      dataUri: { type: String, required: true },
      mimeType: { type: String, required: true },
      width: { type: Number, required: true },
      height: { type: Number, required: true },
    },
    colors: {
      primary: { type: String, required: true },
      secondary: { type: String, required: true },
      accent: { type: String, required: true },
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    website: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      default: '',
      trim: true,
    },
    whatsapp: {
      type: String,
      default: '',
      trim: true,
    },
    address: {
      type: String,
      default: '',
      trim: true,
    },
  },
  { timestamps: true }
);

// Compound index to quickly find the latest active brand profile for a partner
BrandProfileSchema.index({ partnerId: 1, isActive: 1, version: -1 });

module.exports = mongoose.model('BrandProfile', BrandProfileSchema);
