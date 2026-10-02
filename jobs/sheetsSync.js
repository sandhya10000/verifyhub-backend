'use strict';
// ============================================================================
// sheetsSync.js — Scheduled Google Sheets export.
//
// Every N minutes (configurable, default 15) each enabled collection is
// queried for docs with sheetSyncedAt == null. Rows are flattened per the
// tab headers in utils/googleSheets.js, appended below the last row, and
// stamped so the next run only picks up new records.
//
// Safety: failures are logged + recorded in config.lastError and NEVER
// thrown into request paths — verification APIs don't depend on this job.
// ============================================================================
const CreditReport = require('../models/creditReport');
const AIAnalysis = require('../models/AIAnalysis');
const RcVerification = require('../models/RcVerification');
const GstVerification = require('../models/GstVerification');
const {
  HEADERS,
  getSheetsConfig,
  saveSheetsConfig,
  getSheetsClient,
  ensureHeaders,
  appendRows,
} = require('../utils/googleSheets');

const BATCH_LIMIT = 500;

const fmtDate = (d) => {
  try {
    return d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '';
  } catch {
    return '';
  }
};

const partnerOf = (doc) => {
  const u = doc.userId && typeof doc.userId === 'object' ? doc.userId : null;
  return { name: u?.name || '', email: u?.email || '' };
};

// Absolute PDF URLs: relative stored paths are prefixed with PUBLIC_APP_URL
// (backend .env, e.g. https://staging.verifyhub.in) so sheet links are
// clickable in any environment. Absolute values pass through untouched.
const pdfLink = (doc) => {
  const raw = doc.reportUrl || doc.localPath || doc.resultPdfPath || '';
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = (process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
  if (!base) return raw;
  return `${base}${raw.startsWith('/') ? '' : '/'}${raw}`;
};

function bureauRow(doc) {
  const p = partnerOf(doc);
  return [
    fmtDate(doc.createdAt), p.name, p.email, doc.bureau || '', doc.name || '',
    doc.pan || '', doc.mobile || '', doc.email || '', doc.dob || '',
    doc.state || '', doc.city || '', doc.pincode || '',
    doc.score ?? '', doc.status || '', doc.failureReason || '', pdfLink(doc),
  ];
}

function aiRow(doc) {
  const p = partnerOf(doc);
  const r = doc.result || {};
  return [
    fmtDate(doc.createdAt), p.name, p.email, doc.fileName || '',
    r.score ?? '', r.scoreBand || '', r.foirPercent ?? '',
    r.maxEligibleAmount ?? '', r.recommendation || '', doc.status || '',
  ];
}

function rcRow(doc) {
  const p = partnerOf(doc);
  return [
    fmtDate(doc.createdAt), p.name, p.email, doc.vehicleNumber || '',
    doc.ownerName || '', doc.status || '', doc.failureReason || '', pdfLink(doc),
  ];
}

function gstRow(doc) {
  const p = partnerOf(doc);
  return [
    fmtDate(doc.createdAt), p.name, p.email, doc.gstin || '',
    doc.legalName || '', doc.status || '', doc.failureReason || '', pdfLink(doc),
  ];
}

const SOURCES = {
  bureau: { model: CreditReport, toRow: bureauRow, sort: { createdAt: 1 } },
  ai: { model: AIAnalysis, toRow: aiRow, sort: { createdAt: 1 } },
  rc: { model: RcVerification, toRow: rcRow, sort: { createdAt: 1 } },
  gst: { model: GstVerification, toRow: gstRow, sort: { createdAt: 1 } },
};

async function syncSource(sheets, spreadsheetId, key, tab, { backfill = false } = {}) {
  const { model, toRow, sort } = SOURCES[key];
  const filter = backfill ? {} : { sheetSyncedAt: null };
  const docs = await model
    .find(filter)
    .populate('userId', 'name email')
    .sort(sort)
    .limit(BATCH_LIMIT)
    .lean();
  if (docs.length === 0) return { pushed: 0 };
  await ensureHeaders(sheets, spreadsheetId, tab, HEADERS[key]);
  const rows = docs.map(toRow);
  const pushed = await appendRows(sheets, spreadsheetId, tab, rows);
  const now = new Date();
  await model.updateMany(
    { _id: { $in: docs.map((d) => d._id) } },
    { $set: { sheetSyncedAt: now } },
  );
  return { pushed };
}

// Runs one full pass over all enabled tabs. Returns per-tab results.
// { backfill: true } ignores the watermark (admin manual run).
async function runSheetsSync({ backfill = false } = {}) {
  const config = await getSheetsConfig();
  const results = {};
  let sheets = null;
  const nowIso = new Date().toISOString();
  const lastSync = {};
  const lastError = {};

  for (const key of Object.keys(SOURCES)) {
    if (!config.enabled[key]) {
      results[key] = { skipped: true };
      continue;
    }
    const tab = (config.tabs && config.tabs[key]) || key;
    try {
      if (!sheets) sheets = await getSheetsClient();
      const { pushed } = await syncSource(sheets, config.spreadsheetId, key, tab, { backfill });
      results[key] = { pushed };
      lastSync[key] = nowIso;
      lastError[key] = null;
    } catch (err) {
      console.error(`[sheets] ${key} sync failed:`, err.message);
      results[key] = { pushed: 0, error: err.message };
      lastError[key] = err.message;
    }
  }

  await saveSheetsConfig({ lastSync, lastError });
  return results;
}

module.exports = { runSheetsSync, SOURCES };
