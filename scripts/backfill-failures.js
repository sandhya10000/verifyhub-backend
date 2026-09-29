// One-off: backfill failureReason/category/errorCode/failedAt for legacy Failed docs.
// Usage: node scripts/backfill-failures.js
require("dotenv").config();
const mongoose = require("mongoose");
const CreditReport = require("../models/creditReport");
const { classifyFailure } = require("../utils/failureReason");

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGO_URI in .env");
  await mongoose.connect(uri);
  const docs = await CreditReport.find({ status: "Failed" })
    .select("_id reportData remarks failureReason createdAt").lean();
  // Repair rows with missing reason OR a stored raw JSON dump (starts with { or [)
  const targets = docs.filter((d) => {
    if (!d.failureReason) return true;
    const t = String(d.failureReason).trim();
    return t.startsWith("{") || t.startsWith("[");
  });
  console.log(`Found ${targets.length} failed reports needing repair (of ${docs.length})`);
  let n = 0;
  for (const d of targets) {
    const c = classifyFailure(d.reportData?.error ?? d.reportData ?? d.remarks ?? d.failureReason ?? null);
    await CreditReport.updateOne(
      { _id: d._id },
      { $set: { failureReason: c.failureReason, failureCategory: c.failureCategory, errorCode: c.errorCode, failedAt: d.createdAt || new Date() } }
    );
    n++;
  }
  console.log(`Backfilled ${n}`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
