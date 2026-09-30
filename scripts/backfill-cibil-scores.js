// One-off: backfill score on CIBIL rows saved as null.
//
// Root cause: the old save path read cibilData.score / cibilData.cibilScore,
// keys Digi never sends. The real path (same one the PDF service uses) is
// TrueLinkCreditReport.Borrower.CreditScore.riskScore. The raw Digi payload
// is stored on every doc (reportData), so scores are recoverable in place.
//
// Usage:
//   node scripts/backfill-cibil-scores.js --dry-run   (default: report only)
//   node scripts/backfill-cibil-scores.js --apply     (write scores)
require("dotenv").config();
const mongoose = require("mongoose");
const CreditReport = require("../models/creditReport");

// Keep in sync with extractCibilScore in controllers/creditController.js
const extractCibilScore = (apiData) => {
  const cibilData = apiData?.data?.cibilData;
  if (!cibilData) return null;
  const candidates = [
    cibilData?.GetCustomerAssetsResponse?.GetCustomerAssetsSuccess?.Asset
      ?.TrueLinkCreditReport?.Borrower?.CreditScore?.riskScore,
    cibilData?.TrueLinkCreditReport?.Borrower?.CreditScore?.riskScore,
    cibilData?.Borrower?.CreditScore?.riskScore,
    cibilData?.score,
    cibilData?.cibilScore,
    cibilData?.creditScore,
  ];
  for (const raw of candidates) {
    if (raw === null || raw === undefined || raw === "" || raw === "-") continue;
    const n = Number(raw);
    if (!Number.isNaN(n) && n >= 300 && n <= 900) return n;
  }
  return null;
};

async function main() {
  const apply = process.argv.includes("--apply");
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGO_URI in .env");
  await mongoose.connect(uri);

  const docs = await CreditReport.find({
    bureau: "CIBIL",
    status: "Success",
    $or: [{ score: null }, { score: { $exists: false } }],
  })
    .select("_id reportData score createdAt")
    .lean();

  console.log(`Found ${docs.length} successful CIBIL rows with null score`);
  let recoverable = 0;
  let stillNull = 0;
  const updates = [];
  for (const d of docs) {
    const s = extractCibilScore(d.reportData);
    if (s !== null) {
      recoverable++;
      updates.push({ id: d._id, score: s });
    } else {
      stillNull++;
    }
  }
  console.log(`Recoverable: ${recoverable} | No score in payload: ${stillNull}`);

  if (!apply) {
    console.log("Dry run — rerun with --apply to write.");
    await mongoose.disconnect();
    return;
  }
  let n = 0;
  for (const u of updates) {
    await CreditReport.updateOne({ _id: u.id }, { $set: { score: u.score } });
    n++;
  }
  console.log(`Backfilled ${n}`);
  await mongoose.disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
