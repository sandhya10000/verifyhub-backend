const mongoose = require("mongoose");

const attachmentSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    filename: { type: String, default: "" },
    mimeType: { type: String, default: "" },
    size: { type: Number, default: 0 },
  },
  { _id: false }
);

const ticketSchema = new mongoose.Schema(
  {
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    category: {
      type: String,
      required: true,
      trim: true,
    },
    reference: {
      type: String,
      trim: true,
      default: "",
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    attachments: {
      type: [attachmentSchema],
      default: [],
    },
    status: {
      type: String,
      enum: ["open", "in-progress", "resolved"],
      default: "open",
    },
    internalNotes: {
      type: String,
      trim: true,
      default: "",
    },
    assignedAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    messages: {
      type: [
        {
          sender: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
          },
          senderRole: {
            type: String,
            enum: ["user", "admin"],
            required: true,
          },
          text: {
            // Optional when the message carries attachments; the controller
            // enforces "text or at least one attachment".
            type: String,
            default: "",
            trim: true,
            maxlength: 2000,
          },
          attachments: {
            type: [attachmentSchema],
            default: [],
          },
          createdAt: {
            type: Date,
            default: Date.now,
          },
        },
      ],
      default: [],
    },
    lastReplyAt: {
      type: Date,
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.models.Ticket || mongoose.model("Ticket", ticketSchema);
