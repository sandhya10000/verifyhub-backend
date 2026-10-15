'use strict';
// ============================================================================
// googleSheets.js — Google Sheets API client for the admin data-export sync.
//
// Auth: service-account key file whose path is set in GOOGLE_SA_KEYFILE.
// The sheet must be shared (Editor) with the service-account email.
// Config (spreadsheet ID, tab names, toggles, schedule) lives in the generic
// Setting doc under key "googleSheets" and is edited from Admin → Settings.
// ============================================================================
const fs = require('fs');
const { google } = require('googleapis');
const Setting = require('../models/Setting');

const DEFAULT_SPREADSHEET_ID = '1KrBGEAI642DmDMan2qT1d0xHfbIVZCSfabbv0Yi6qSw';

const DEFAULT_TABS = {
  bureau: 'Bureau',
  ai: 'AI',
  rc: 'RC',
  gst: 'GST',
  partners: 'Partners',
};

// Essential columns (row 1 of each tab). Admin can rename/reorder later —
// appends always go below the last row, so header edits don't break sync.
const HEADERS = {
  bureau: [
    'Date', 'Partner Name', 'Partner Email', 'Bureau', 'Customer Name',
    'PAN', 'Mobile', 'Email', 'DOB', 'State', 'City', 'Pincode',
    'Score', 'Status', 'Failure Reason', 'PDF Link',
  ],
  ai: [
    'Date', 'Partner Name', 'Partner Email', 'File Name', 'Score',
    'Score Band', 'FOIR %', 'Eligible Amount', 'Recommendation', 'Status',
    'Report Link',
  ],
  rc: [
    'Date', 'Partner Name', 'Partner Email', 'Vehicle No.', 'Owner Name',
    'Status', 'Failure Reason', 'PDF Link',
  ],
  gst: [
    'Date', 'Partner Name', 'Partner Email', 'GSTIN', 'Legal Name',
    'Status', 'Failure Reason', 'PDF Link',
  ],
  partners: [
    'Date Joined', 'Partner ID', 'Name', 'Email', 'Phone', 'State',
    'City', 'Pincode', 'Wallet Balance', 'Plan', 'Active', 'Last Login',
  ],
};

const DEFAULT_CONFIG = {
  spreadsheetId: DEFAULT_SPREADSHEET_ID,
  tabs: { ...DEFAULT_TABS },
  enabled: { bureau: true, ai: true, rc: true, gst: true, partners: true },
  // Optional per-tab spreadsheet override. Empty/missing falls back to the
  // main spreadsheetId above — use it when Partners lives in its own file.
  spreadsheetIds: { bureau: '', ai: '', rc: '', gst: '', partners: '' },
  scheduleMinutes: 15,
  // Last-run bookkeeping (updated by the job, shown in Admin → Settings).
  lastSync: { bureau: null, ai: null, rc: null, gst: null, partners: null },
  lastError: { bureau: null, ai: null, rc: null, gst: null, partners: null },
};

async function getSheetsConfig() {
  const doc = await Setting.findOne({ key: 'googleSheets' }).lean();
  const stored = (doc && doc.value) || {};
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    tabs: { ...DEFAULT_TABS, ...(stored.tabs || {}) },
    enabled: { ...DEFAULT_CONFIG.enabled, ...(stored.enabled || {}) },
    spreadsheetIds: { ...DEFAULT_CONFIG.spreadsheetIds, ...(stored.spreadsheetIds || {}) },
    lastSync: { ...DEFAULT_CONFIG.lastSync, ...(stored.lastSync || {}) },
    lastError: { ...DEFAULT_CONFIG.lastError, ...(stored.lastError || {}) },
  };
}

function resolveSpreadsheetId(config, key) {
  const override = (config.spreadsheetIds && config.spreadsheetIds[key]) || '';
  return (override && override.trim()) || config.spreadsheetId;
}

async function saveSheetsConfig(patch) {
  const current = await getSheetsConfig();
  const next = {
    ...current,
    ...patch,
    tabs: { ...current.tabs, ...(patch.tabs || {}) },
    enabled: { ...current.enabled, ...(patch.enabled || {}) },
    spreadsheetIds: { ...current.spreadsheetIds, ...(patch.spreadsheetIds || {}) },
    lastSync: { ...current.lastSync, ...(patch.lastSync || {}) },
    lastError: { ...current.lastError, ...(patch.lastError || {}) },
  };
  delete next._id;
  await Setting.updateOne(
    { key: 'googleSheets' },
    {
      $set: {
        value: next,
        description: 'Google Sheets data-export sync (Admin → Settings)',
      },
    },
    { upsert: true },
  );
  return next;
}

// Pre-boot seed so Admin → Settings shows the sheet on first load.
async function ensureSheetsConfigSeeded() {
  const exists = await Setting.findOne({ key: 'googleSheets' }).lean();
  if (!exists) {
    await Setting.create({
      key: 'googleSheets',
      value: {
        spreadsheetId: DEFAULT_SPREADSHEET_ID,
        tabs: { ...DEFAULT_TABS },
        enabled: { bureau: true, ai: true, rc: true, gst: true, partners: true },
        spreadsheetIds: { bureau: '', ai: '', rc: '', gst: '', partners: '' },
        scheduleMinutes: 15,
        lastSync: { bureau: null, ai: null, rc: null, gst: null, partners: null },
        lastError: { bureau: null, ai: null, rc: null, gst: null, partners: null },
      },
      description: 'Google Sheets data-export sync (Admin → Settings)',
    });
    console.log('[sheets] default googleSheets config seeded');
  }
}

// Presence-only status for the admin UI (never leaks key contents).
function keyFileStatus() {
  const keyFile = process.env.GOOGLE_SA_KEYFILE || '';
  if (!keyFile) return { configured: false, message: 'GOOGLE_SA_KEYFILE not set' };
  try {
    const raw = JSON.parse(fs.readFileSync(keyFile, 'utf-8'));
    return {
      configured: true,
      clientEmail: raw.client_email || null,
      message: raw.client_email
        ? `Key loaded — share the sheet (Editor) with ${raw.client_email}`
        : 'Key file parsed but client_email missing',
    };
  } catch (err) {
    return { configured: false, message: `Key file unreadable: ${err.message}` };
  }
}

let _sheetsClient = null;
async function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;
  const keyFile = process.env.GOOGLE_SA_KEYFILE || '';
  if (!keyFile) throw new Error('GOOGLE_SA_KEYFILE env var is not set');
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheetsClient = google.sheets({ version: 'v4', auth });
  return _sheetsClient;
}

function resetSheetsClient() {
  _sheetsClient = null;
}

// Create the header row if the tab is empty (lets the backend own columns).
// When we ship a NEW trailing column (e.g. AI "Report Link"), existing tabs
// only get the missing tail appended — existing headers (including admin
// renames/reorders) are never overwritten.
function colLetter(idx) {
  let s = '';
  let n = idx;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

async function ensureHeaders(sheets, spreadsheetId, tab, headers) {
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A1:Z1`,
  });
  const rows = read.data.values || [];
  if (rows.length === 0 || rows[0].length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
    return;
  }
  if (rows[0].length < headers.length) {
    const missing = headers.slice(rows[0].length);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!${colLetter(rows[0].length)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [missing] },
    });
  }
}

async function appendRows(sheets, spreadsheetId, tab, rows) {
  if (!rows || rows.length === 0) return 0;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
  return rows.length;
}

// Date-bearing column indexes (0-based) per tab. Sheets auto-parses our
// date strings but may display them as raw serial numbers (e.g. 46290.73)
// when the column has no date format — so every sync enforces a DateTime
// number format on these columns (below the header row). Idempotent and
// column-wide, so already-synced rows get fixed too.
const DATE_COLS = {
  bureau: [0],
  ai: [0],
  rc: [0],
  gst: [0],
  partners: [0, 11],
};

async function ensureDateColumnFormat(sheets, spreadsheetId, tab, cols) {
  try {
    if (!cols || cols.length === 0) return;
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties',
    });
    const sheet = (meta.data.sheets || []).find(
      (s) => s.properties && s.properties.title === tab,
    );
    if (!sheet || sheet.properties.sheetId == null) {
      const titles = (meta.data.sheets || []).map((s) => s.properties && s.properties.title).join(', ');
      console.error(`[sheets] tab "${tab}" not found in spreadsheet (tabs: ${titles}) — check Admin → Settings tab names`);
      return;
    }
    const sheetId = sheet.properties.sheetId;
    const requests = cols.map((c) => ({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 1,
          startColumnIndex: c,
          endColumnIndex: c + 1,
        },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: 'DATE_TIME', pattern: 'dd-mmm-yyyy hh:mm' },
          },
        },
        fields: 'userEnteredFormat.numberFormat',
      },
    }));
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  } catch (err) {
    // Formatting must never fail a sync — data already landed above.
    console.error(`[sheets] date-format skipped for tab "${tab}":`, err.message);
  }
}

// Overwrite one full row (1-indexed sheet row number, header is row 1).
async function updateRow(sheets, spreadsheetId, tab, rowNumber, row) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

// Map column B (Partner ID) values → 1-indexed sheet row numbers.
// Used by the Partners upsert so edits update the same row instead of
// appending duplicates. Returns {} when the tab is empty/missing.
async function getPartnerIdRowMap(sheets, spreadsheetId, tab) {
  try {
    const read = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!B2:B`,
    });
    const values = read.data.values || [];
    const map = {};
    values.forEach((r, idx) => {
      const id = (r && r[0] && String(r[0]).trim()) || '';
      if (id && !map[id]) map[id] = idx + 2;
    });
    return map;
  } catch (err) {
    if (err && (err.code === 400 || /Unable to parse range/i.test(err.message || ''))) return {};
    throw err;
  }
}

module.exports = {
  HEADERS,
  DATE_COLS,
  DEFAULT_CONFIG,
  getSheetsConfig,
  saveSheetsConfig,
  resolveSpreadsheetId,
  ensureSheetsConfigSeeded,
  keyFileStatus,
  getSheetsClient,
  resetSheetsClient,
  ensureHeaders,
  ensureDateColumnFormat,
  appendRows,
  updateRow,
  getPartnerIdRowMap,
};
