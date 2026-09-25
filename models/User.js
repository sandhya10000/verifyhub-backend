const mongoose = require("mongoose");
const Counter = require("./counter.model");

const userSchema = new mongoose.Schema(
  {
    
    partner_id: {
      type: String,
      unique: true,
      sparse: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    state: {
      type: String,
      trim: true,
    },

    city: {
      type: String,
      trim: true,
    },

    pincode: {
      type: String,
      trim: true,
      match: [/^\d{6}$/, "Pincode must be 6 digits"],
    },

    password: {
      type: String,
      required: true,
      minlength: 6,
    },
    role: {
      type: String,
      enum: ["admin", "user"],
      default: "user",
    },
    walletBalance: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Tracks when this admin last opened the Support Tickets page.
    // Used to compute the "new tickets since last visit" badge count.
    supportLastSeenAt: {
      type: Date,
      default: null,
    },
  },

  {
    timestamps: true,
  },
);

// Generate partner_id before saving a new user
userSchema.pre("save", async function () {
  if (this.isNew && !this.partner_id) {
    const counter = await Counter.findByIdAndUpdate(
      "partner_id",
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
    );

    this.partner_id = "VH" + String(counter.seq).padStart(3, "0");
  }
});

module.exports = mongoose.models.User || mongoose.model("User", userSchema);
