// One-off: move AI upload files from the legacy repo-root dir into the
// backend-local served tree (<backend>/uploads/ai-analysis), matching the
// relocated UPLOAD_DIR. Run on EVERY machine holding files (local + staging
// + prod) — each machine migrates only its own files. DB needs no change:
// storedFileName basenames are location-independent.
//
// Legacy: <repo-root>/uploads/ai-analysis  (UPLOAD_DIR before relocation)
// New:    <backend>/uploads/ai-analysis    (current UPLOAD_DIR)
//
// Usage:
//   node scripts/migrate-ai-uploads.js --dry-run   (default: report only)
//   node scripts/migrate-ai-uploads.js --apply     (move files)
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const { UPLOAD_DIR: NEW_DIR } = require("../config/uploadConfig");

// Legacy location: two levels above backend dir (where UPLOAD_DIR pointed
// before it was moved under backend/uploads).
const OLD_DIR = path.join(__dirname, "..", "..", "uploads", "ai-analysis");

async function main() {
  const apply = process.argv.includes("--apply");
  console.log("Old dir:", OLD_DIR);
  console.log("New dir:", NEW_DIR);

  if (!fs.existsSync(OLD_DIR)) {
    console.log("Old dir does not exist — nothing to migrate.");
    return;
  }
  fs.mkdirSync(NEW_DIR, { recursive: true });

  const files = fs
    .readdirSync(OLD_DIR)
    .filter((f) => /\.(pdf|json)$/i.test(f));
  console.log(`Found ${files.length} file(s) in old dir`);

  let moved = 0;
  let skipped = 0;
  for (const f of files) {
    const src = path.join(OLD_DIR, f);
    const dest = path.join(NEW_DIR, f);
    if (fs.existsSync(dest)) {
      const sameSize =
        fs.statSync(src).size === fs.statSync(dest).size;
      console.log(`${sameSize ? "Already moved" : "CONFLICT (differs)"}: ${f}`);
      if (sameSize) skipped++;
      continue;
    }
    if (apply) {
      fs.copyFileSync(src, dest);
      const ok = fs.statSync(src).size === fs.statSync(dest).size;
      if (!ok) {
        fs.unlinkSync(dest);
        console.log(`FAILED byte check, skipped: ${f}`);
        continue;
      }
      fs.unlinkSync(src);
      moved++;
    }
  }

  if (!apply) {
    console.log("Dry run — rerun with --apply to move files.");
    return;
  }
  console.log(`Moved ${moved}, already-moved ${skipped}.`);
  const remaining = fs.readdirSync(OLD_DIR).filter((f) => /\.(pdf|json)$/i.test(f));
  console.log(
    remaining.length === 0
      ? "Old dir is empty — safe to remove it manually."
      : `Old dir still holds ${remaining.length} file(s); leaving it in place.`,
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
