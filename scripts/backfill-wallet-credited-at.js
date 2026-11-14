// One-time backfill, RUN BEFORE deploying the recharge reconciliation change.
//
// Wallet crediting is now guarded by Transaction.walletCreditedAt. Recharge
// rows created before that field existed are SUCCESS and were already credited,
// but have no walletCreditedAt. Without this backfill, a webhook or reconcile
// pass could credit them a second time.
//
// Sets walletCreditedAt = updatedAt on SUCCESS WALLET_RECHARGE rows that lack it.
// Dry run by default. Pass --apply to write.
//
// Usage:
//   MONGO_URI=... node scripts/backfill-wallet-credited-at.js           (dry run)
//   MONGO_URI=... node scripts/backfill-wallet-credited-at.js --apply
const mongoose = require("mongoose");

async function main() {
  const apply = process.argv.includes("--apply");
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGO_URI env var");
  await mongoose.connect(uri);

  const Transaction = require("../models/Transaction");
  const filter = {
    purpose: "WALLET_RECHARGE",
    status: "SUCCESS",
    walletCreditedAt: { $exists: false },
  };

  const count = await Transaction.countDocuments(filter);
  console.log(`[backfill] SUCCESS wallet recharges without walletCreditedAt: ${count}`);

  if (!apply) {
    console.log("[backfill] dry run. Re-run with --apply to write.");
  } else if (count) {
    const res = await Transaction.collection.updateMany(filter, [
      { $set: { walletCreditedAt: { $ifNull: ["$updatedAt", "$createdAt"] } } },
    ]);
    console.log(`[backfill] updated ${res.modifiedCount} row(s)`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("[backfill] failed:", e.message);
  process.exit(1);
});
