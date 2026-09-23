// models/counter.model.js
const mongoose = require("mongoose");

const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // e.g. "partner_id"
  seq: { type: Number, default: 0 },
});

module.exports =
  mongoose.models.Counter || mongoose.model("Counter", counterSchema);