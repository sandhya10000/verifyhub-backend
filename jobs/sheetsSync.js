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
const User = require('../models/User');
const {
  HEADERS,
  DATE_COLS,
  getSheetsConfig,
  saveSheetsConfig,
  resolveSpreadsheetId,
  getSheetsClient,
  ensureHeaders,
  ensureDateColumnFormat,
  appendRows,
  updateRow,
  getPartnerIdRowMap,
} = require('../utils/googleSheets');

const BATCH_LIMIT = 500;

// Locale-proof IST timestamp, forced to TEXT in Sheets via a leading
// apostrophe: "'2026-10-15 14:30". The apostrophe is Sheets' text-forcing
// marker (stored but not displayed), so the value can NEVER be parsed into
// a date serial (46292.97…) no matter the sheet locale or column format.
// ISO order keeps the column chronologically sortable as text.
const fmtDate = (d) => {
  try {
    if (!d) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(d));
    const p = {};
    for (const x of parts) p[x.type] = x.value;
    const hour = p.hour === '24' ? '00' : p.hour;
    return `'${p.year}-${p.month}-${p.day} ${hour}:${p.minute}`;
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
    aiReportLink(doc),
  ];
}

// Link to the resulted AI document (the same .html report the app's download
// button serves). Sheet clicks carry no login token, so completed analyses get
// a signed public share URL (HMAC, 2-year validity) instead of the authed
// download endpoint, which 401s with "missing token" in a browser.
function aiReportLink(doc) {
  if (doc.resultPdfPath) return pdfLink(doc);
  const ready = doc.htmlStatus === 'completed' || doc.status === 'completed';
  if (!ready || !doc._id) return '';
  try {
    const { signReportLink } = require('../utils/reportShare');
    const signed = signReportLink(String(doc._id));
    if (signed) return signed;
  } catch (e) {
    console.error('[sheets] report share-sign failed:', e.message);
  }
  const base = (process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
  if (!base) return '';
  return `${base}/api/ai-analyzer/${doc._id}/download-pdf`;
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

function partnerRow(doc) {
  return [
    fmtDate(doc.createdAt), doc.partner_id || '', doc.name || '',
    doc.email || '', doc.phone || '', doc.state || '', doc.city || '',
    doc.pincode || '', doc.walletBalance ?? '', doc.activePlan || '',
    doc.isActive ? 'Active' : 'Suspended', fmtDate(doc.lastLoginAt),
  ];
}

const SOURCES = {
  bureau: { model: CreditReport, toRow: bureauRow, sort: { createdAt: 1 } },
  ai: { model: AIAnalysis, toRow: aiRow, sort: { createdAt: 1 } },
  rc: { model: RcVerification, toRow: rcRow, sort: { createdAt: 1 } },
  gst: { model: GstVerification, toRow: gstRow, sort: { createdAt: 1 } },
  partners: { model: User, toRow: partnerRow, sort: { createdAt: 1 }, upsert: true },
};

// Partners use upsert semantics (update the same row on wallet/status/
// profile edits) keyed by Partner ID (column B). New partners append,
// known IDs overwrite their row in place. Backfill upserts everything
// (up to BATCH_LIMIT per run); incremental runs only pick up never-synced
// docs plus docs edited since their last sync stamp.
async function syncPartnersUpsert(sheets, spreadsheetId, tab, { backfill = false } = {}) {
  const filter = backfill
    ? { role: 'user' }
    : {
        role: 'user',
        $or: [
          { sheetSyncedAt: null },
          { $expr: { $gt: ['$updatedAt', '$sheetSyncedAt'] } },
        ],
      };
  const docs = await User
    .find(filter)
    .sort({ createdAt: 1 })
    .limit(BATCH_LIMIT)
    .setOptions({ allowDiskUse: true })
    .lean();
  // Headers + date-column formatting run on EVERY pass (even with zero new
  // docs) so already-synced serial columns get repaired without a re-push.
  await ensureHeaders(sheets, spreadsheetId, tab, HEADERS.partners);
  await ensureDateColumnFormat(sheets, spreadsheetId, tab, DATE_COLS.partners);
  if (docs.length === 0) return { pushed: 0, updated: 0 };
  const idRowMap = await getPartnerIdRowMap(sheets, spreadsheetId, tab);
  let pushed = 0;
  let updated = 0;
  const appendBatch = [];
  const appendDocs = [];
  for (const doc of docs) {
    const key = (doc.partner_id && String(doc.partner_id).trim()) || '';
    // Docs without a partner_id (legacy) can't be matched reliably — append.
    const rowNumber = key ? idRowMap[key] : null;
    if (rowNumber) {
      await updateRow(sheets, spreadsheetId, tab, rowNumber, partnerRow(doc));
      updated += 1;
    } else {
      appendBatch.push(partnerRow(doc));
      appendDocs.push(doc);
      if (key) idRowMap[key] = true; // dedupe repeats within the same batch
    }
  }
  if (appendBatch.length) {
    pushed = await appendRows(sheets, spreadsheetId, tab, appendBatch);
  }
  const now = new Date();
  await User.updateMany(
    { _id: { $in: docs.map((d) => d._id) } },
    { $set: { sheetSyncedAt: now } },
  );
  return { pushed, updated };
}

async function syncSource(sheets, spreadsheetId, key, tab, { backfill = false } = {}) {
  const { model, toRow, sort } = SOURCES[key];
  const filter = backfill ? {} : { sheetSyncedAt: null };
  const docs = await model
    .find(filter)
    .populate('userId', 'name email')
    .sort(sort)
    .limit(BATCH_LIMIT)
    // Large unsynced backlogs can spill past the 32 MB in-memory sort limit
    // (seen on AIAnalysis) — allow disk use; compound indexes on
    // {sheetSyncedAt, createdAt} keep the steady state indexed.
    .setOptions({ allowDiskUse: true })
    // AI docs carry huge inline payloads (htmlReport, rawModelResponse)
    // that the sheet never needs — exclude them to keep batches light.
    // Harmless for models that lack these paths.
    .select('-htmlReport -rawModelResponse')
    .lean();
  // Headers + date-column formatting run on EVERY pass (even with zero new
  // docs) so already-synced serial columns get repaired without a re-push.
  await ensureHeaders(sheets, spreadsheetId, tab, HEADERS[key]);
  await ensureDateColumnFormat(sheets, spreadsheetId, tab, DATE_COLS[key]);
  if (docs.length === 0) return { pushed: 0 };
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
    const spreadsheetId = resolveSpreadsheetId(config, key);
    try {
      if (!sheets) sheets = await getSheetsClient();
      if (key === 'partners') {
        const { pushed, updated } = await syncPartnersUpsert(sheets, spreadsheetId, tab, { backfill });
        results[key] = { pushed, updated };
      } else {
        const { pushed } = await syncSource(sheets, spreadsheetId, key, tab, { backfill });
        results[key] = { pushed };
      }
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

module.exports = { runSheetsSync, SOURCES, syncPartnersUpsert };
