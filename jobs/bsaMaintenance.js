'use strict';

const BankStatementAnalysis = require('../models/BankStatementAnalysis');
const path = require('path');
const fs = require('fs');

/**
 * Sweep records stuck in 'Processing' or 'Finalizing' for more than 15 minutes.
 * Marks them as Failed with clear failureReason and NO wallet charge.
 */
async function sweepStuckBsaRecords() {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000);
  try {
    const result = await BankStatementAnalysis.updateMany(
      {
        status: { $in: ['Processing', 'Finalizing'] },
        createdAt: { $lt: cutoff },
      },
      {
        $set: {
          status: 'Failed',
          failureReason: 'Analysis interrupted, please retry',
          failureCategory: 'TIMEOUT',
          errorCode: 'JOB_INTERRUPTED_TIMEOUT',
          failedAt: new Date(),
        },
      }
    );

    if (result.modifiedCount > 0) {
      console.log(`[bsa-maintenance] Swept ${result.modifiedCount} stuck BSA records to Failed.`);
    }
  } catch (err) {
    console.error('[bsa-maintenance] Sweep stuck records failed:', err.message);
  }
}

/**
 * Retention cleanup: Remove old report PDF and HTML files past retention window.
 * Default retention is 90 days (configurable via BSA_RETENTION_DAYS).
 * Keeps metadata rows in MongoDB untouched.
 */
async function cleanupOldBsaReports() {
  const retentionDays = parseInt(process.env.BSA_RETENTION_DAYS, 10) || 90;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const reportDir = process.env.REPORT_DIR || path.join(__dirname, '..', 'private', 'bsa-reports');

  try {
    const oldDocs = await BankStatementAnalysis.find({
      createdAt: { $lt: cutoff },
      status: 'Success',
      localPath: { $ne: null },
    }).select('_id localPath').lean();

    let filesCleaned = 0;
    for (const doc of oldDocs) {
      const pdfPath = path.join(reportDir, `${String(doc._id)}.pdf`);
      const htmlPath = path.join(reportDir, `${String(doc._id)}.html`);
      try {
        if (fs.existsSync(pdfPath)) {
          fs.unlinkSync(pdfPath);
          filesCleaned++;
        }
      } catch (e) { /* ignore */ }
      try {
        if (fs.existsSync(htmlPath)) {
          fs.unlinkSync(htmlPath);
        }
      } catch (e) { /* ignore */ }
    }

    if (filesCleaned > 0) {
      console.log(`[bsa-maintenance] Cleaned ${filesCleaned} expired report file(s) older than ${retentionDays} days.`);
    }
  } catch (err) {
    console.error('[bsa-maintenance] Retention cleanup failed:', err.message);
  }
}

module.exports = {
  sweepStuckBsaRecords,
  cleanupOldBsaReports,
};

