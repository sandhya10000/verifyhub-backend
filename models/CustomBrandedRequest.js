const mongoose = require('mongoose');
const Counter = require('./counter.model');

const customBrandedRequestSchema = new mongoose.Schema(
  {
    // Auto-generated human-readable ID (CR-1001, CR-1002, …)
    requestId: {
      type: String,
      unique: true,
    },

    // Who made the request
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // Contact details collected at request time
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },

    // ── Payment fields ─────────────────────────────────────────────────────────
    // Razorpay order ID (set at order-creation; idempotency key for /verify)
    orderId: {
      type: String,
      default: null,
      index: true,
      sparse: true,
    },
    // Razorpay payment ID (set when payment is confirmed)
    paymentId: {
      type: String,
      default: null,
    },
    // Amount charged in ₹ (always CBR_PRICE_INR, stored for audit)
    amount: {
      type: Number,
      default: null,
    },
    // Payment lifecycle. 'Unpaid' kept for legacy/free records; all new
    // requests must be 'Paid' before status can be 'Active'.
    paymentStatus: {
      type: String,
      enum: ['Unpaid', 'Paid'],
      default: 'Paid', // new requests created only after payment verified
    },

    // ── Request lifecycle ─────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['Pending', 'Active', 'Completed', 'Cancelled'],
      default: 'Active',
    },
  },
  {
    timestamps: true, // createdAt + updatedAt
  },
);

// Generate the CR-XXXX request ID before first save
customBrandedRequestSchema.pre('save', async function () {
  if (this.isNew && !this.requestId) {
    const counter = await Counter.findByIdAndUpdate(
      'custom_branded_request_id',
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
    );
    // Start from CR-1001 (seq starts at 0 → +1 → offset 1000)
    this.requestId = 'CR-' + String(1000 + counter.seq);
  }
});

module.exports =
  mongoose.models.CustomBrandedRequest ||
  mongoose.model('CustomBrandedRequest', customBrandedRequestSchema);

