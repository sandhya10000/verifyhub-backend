// One-time migration: single-plan launch mode.
// - Backs up the current Pricing doc to scripts/single-plan-backup-<ts>.json
// - Syncs all 5 tier rows to founder single-plan prices + minRecharge 1000
// - Moves every partner to activePlan "starter", clears pendingPlanChoice
//   for funded wallets (>=1000), forces pick for unfunded ones.
// Run: node scripts/migrate-single-plan.js
// Rollback: restore the backup JSON via mongo import or Admin Pricing page,
//   then flip SINGLE_PLAN_MODE to false (see models/Pricing.js).
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const SINGLE_ROW = { recharge: 1000, cibil: 60, experian: 40, crif: 50, equifax: 40, cibilFailed: 60 };

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGO_URI env var to run this migration");
  await mongoose.connect(uri);

  const Pricing = require("../models/Pricing");
  const User = require("../models/User");
  const { resetPricingCache } = require("../utils/wallet");

  const before = await Pricing.findOne({ key: "default" }).lean();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(__dirname, `single-plan-backup-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(before || {}, null, 2));
  console.log("[migrate-single-plan] backup written:", backupPath);

  const set = { minRecharge: 1000, "ai.base": 100, "ai.gstRate": 18, "aiFail.base": 100, "aiFail.gstRate": 0, "rc.base": 10, "rc.gstRate": 0, "gst.base": 10, "gst.gstRate": 0, "otherFailedCharge.base": 30, "otherFailedCharge.gstRate": 0 };
  for (const tier of ["startup", "starter", "growth", "pro", "enterprise"]) {
    for (const [f, v] of Object.entries(SINGLE_ROW)) set[`plans.${tier}.${f}`] = v;
  }
  await Pricing.updateOne({ key: "default" }, { $set: set }, { upsert: true });
  console.log("[migrate-single-plan] pricing synced to single-plan row:", SINGLE_ROW);

  // No forced plan pick: everyone onto starter, nobody gated.
  const migrated = await User.updateMany(
    { role: { $ne: "admin" } },
    { $set: { activePlan: "starter", pendingPlanChoice: false } },
  );
  console.log(`[migrate-single-plan] users migrated onto starter: ${migrated.modifiedCount}`);

  resetPricingCache();
  await mongoose.disconnect();
  console.log("[migrate-single-plan] done. Restart backend to clear in-memory pricing cache.");
}

main().catch((e) => { console.error("[migrate-single-plan] FAILED:", e.message); process.exit(1); });
