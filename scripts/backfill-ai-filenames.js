// One-off: backfill storedFileName on AIAnalysis docs predating the field.
//
// storedFileName = basename of the multer-renamed file on disk. It lets the
// eye icon serve /ai-uploads/<storedFileName> directly and keeps working
// across machines (unlike the absolute filePath recorded at upload time).
// MUST be run wherever the real files + DB live (staging/prod server).
//
// Usage:
//   node scripts/backfill-ai-filenames.js --dry-run   (default: report only)
//   node scripts/backfill-ai-filenames.js --apply     (write filenames)
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const AIAnalysis = require("../models/AIAnalysis");
const { UPLOAD_DIR } = require("../config/uploadConfig");

async function main() {
  const apply = process.argv.includes("--apply");
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGO_URI in .env");
  await mongoose.connect(uri);

  console.log("Upload dir:", UPLOAD_DIR);

  const docs = await AIAnalysis.find({
    $or: [
      { storedFileName: null },
      { storedFileName: { $exists: false } },
      { storedFileName: "" },
    ],
  })
    .select("_id fileName filePath storedFileName createdAt")
    .lean();

  console.log(`Found ${docs.length} AI analyses missing storedFileName`);
  let fillable = 0;
  let missingOnDisk = 0;
  const updates = [];
  for (const d of docs) {
    const base = d.filePath ? path.basename(String(d.filePath)) : "";
    if (!base) {
      missingOnDisk++;
      continue;
    }
    if (fs.existsSync(path.join(UPLOAD_DIR, base))) {
      fillable++;
      updates.push({ id: d._id, storedFileName: base });
    } else {
      missingOnDisk++;
      console.log(`Missing on disk: ${d._id} (wanted ${base})`);
    }
  }
  console.log(`Fillable: ${fillable} | Missing on disk: ${missingOnDisk}`);

  if (!apply) {
    console.log("Dry run — rerun with --apply to write.");
    await mongoose.disconnect();
    return;
  }
  let n = 0;
  for (const u of updates) {
    await AIAnalysis.updateOne(
      { _id: u.id },
      { $set: { storedFileName: u.storedFileName } },
    );
    n++;
  }
  console.log(`Backfilled ${n}`);
  await mongoose.disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
