/**
 * Regenerates CIBIL bureau report PDFs from the raw bureau payload that is
 * already stored in `creditreports.reportData`.
 *
 * Why this exists: the provider changed `TradeLinePartition` from an array to
 * an index-keyed map, which made the PDF extractor silently drop every credit
 * account. The extractor is fixed now, but the PDFs generated before the fix
 * still show "Credit accounts not reported by bureau." - this script rebuilds
 * them from the stored payload without spending another bureau pull.
 *
 * Usage:
 *   node scripts/regenerateCibilPdfs.js            # only broken reports
 *   node scripts/regenerateCibilPdfs.js --all      # every CIBIL report
 *   node scripts/regenerateCibilPdfs.js --dry-run  # list only, no writes
 *   node scripts/regenerateCibilPdfs.js --repair-missing
 *                                                    # also rebuild reports whose
 *                                                    # PDF file is gone from disk
 *                                                    # (run on the file-serving host)
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const mongoose = require("mongoose");

const CreditReport = require("../models/creditReport");
const {
  generateCibilPdf,
  prepareCibilPdfData,
} = require("../services/cibilPdf.service");

const ALL = process.argv.includes("--all");
const DRY_RUN = process.argv.includes("--dry-run");
const REPAIR_MISSING = process.argv.includes("--repair-missing");

const getTrueLinkCreditReport = (apiResponse) =>
  apiResponse?.data?.cibilData?.GetCustomerAssetsResponse?.GetCustomerAssetsSuccess
    ?.Asset?.TrueLinkCreditReport || null;

const isIndexedMap = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const keys = Object.keys(value);

  return keys.length > 0 && keys.every((key) => /^\d+$/.test(key));
};

// A report is "broken" when the payload holds accounts but the extraction
// path would have dropped them because of the map shape.
const isAffected = (reportData) => {
  const report = getTrueLinkCreditReport(reportData);

  if (!report) return false;

  return isIndexedMap(report?.TradeLinePartition);
};

const removeOldFile = (relativePath) => {
  if (!relativePath) return;

  const filePath = path.join(process.cwd(), relativePath);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    console.log("    removed stale file:", path.basename(filePath));
  }
};

// The PDF file referenced by a report can go missing from the uploads folder
// (manual cleanup, moved deploys, ...). Such a report would 404 for the user,
// so it is regenerated from the stored payload as well.
// NOTE: only meaningful when this script runs on the machine that serves the
// files - the database is shared but the uploads folder is per-host.
const isFileMissing = (relativePath) => {
  if (!relativePath) return true;

  return !fs.existsSync(path.join(process.cwd(), relativePath));
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  console.log("MongoDB Connected");

  const filter = { bureau: "CIBIL" };

  const reports = await CreditReport.find(filter).sort({ createdAt: -1 }).lean();

  const targets = ALL
    ? reports
    : reports.filter(
        (report) =>
          report.status === "Success" &&
          (isAffected(report.reportData) ||
            (REPAIR_MISSING && isFileMissing(report.localPath))),
      );

  console.log(
    `\nFound ${targets.length} CIBIL report(s) to ${DRY_RUN ? "inspect" : "regenerate"} ` +
      `(of ${reports.length} total)\n`,
  );

  let regenerated = 0;
  let failed = 0;

  for (const report of targets) {
    const label = `${report._id} | ${new Date(report.createdAt).toISOString()}`;

    try {
      if (DRY_RUN) {
        const preview = prepareCibilPdfData(
          report.reportData,
          report._id.toString(),
        );

        console.log(
          `  OK   ${label} -> accounts: ${preview.accounts.length}, ` +
            `inquiries: ${preview.inquiries.length}`,
        );

        regenerated += 1;

        continue;
      }

      const pdf = await generateCibilPdf(report.reportData, report._id.toString());

      const accounts = pdf?.data?.accounts?.length ?? 0;

      console.log(
        `  OK   ${label} -> ${pdf.fileName} (accounts: ${accounts})`,
      );

      await CreditReport.updateOne(
        { _id: report._id },
        {
          $set: {
            localPath: pdf.relativePath,
            reportUrl: pdf.relativePath,
            updatedAt: new Date(),
          },
        },
      );

      if (report.localPath && report.localPath !== pdf.relativePath) {
        removeOldFile(report.localPath);
      }

      regenerated += 1;
    } catch (error) {
      failed += 1;

      console.error(`  FAIL ${label} -> ${error.message}`);
    }  }

  console.log(`\nDone. regenerated: ${regenerated}, failed: ${failed}`);

  await mongoose.disconnect();
})().catch(async (error) => {
  console.error("Regeneration aborted:", error);

  await mongoose.disconnect().catch(() => {});

  process.exit(1);
});
