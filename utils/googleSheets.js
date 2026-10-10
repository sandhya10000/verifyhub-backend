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
  ],
  rc: [
    'Date', 'Partner Name', 'Partner Email', 'Vehicle No.', 'Owner Name',
    'Status', 'Failure Reason', 'PDF Link',
  ],
  gst: [
    'Date', 'Partner Name', 'Partner Email', 'GSTIN', 'Legal Name',
    'Status', 'Failure Reason', 'PDF Link',
  ],
};

const DEFAULT_CONFIG = {
  spreadsheetId: DEFAULT_SPREADSHEET_ID,
  tabs: { ...DEFAULT_TABS },
  enabled: { bureau: true, ai: true, rc: true, gst: true },
  scheduleMinutes: 15,
  // Last-run bookkeeping (updated by the job, shown in Admin → Settings).
  lastSync: { bureau: null, ai: null, rc: null, gst: null },
  lastError: { bureau: null, ai: null, rc: null, gst: null },
};

async function getSheetsConfig() {
  const doc = await Setting.findOne({ key: 'googleSheets' }).lean();
  const stored = (doc && doc.value) || {};
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    tabs: { ...DEFAULT_TABS, ...(stored.tabs || {}) },
    enabled: { ...DEFAULT_CONFIG.enabled, ...(stored.enabled || {}) },
    lastSync: { ...DEFAULT_CONFIG.lastSync, ...(stored.lastSync || {}) },
    lastError: { ...DEFAULT_CONFIG.lastError, ...(stored.lastError || {}) },
  };
}

async function saveSheetsConfig(patch) {
  const current = await getSheetsConfig();
  const next = {
    ...current,
    ...patch,
    tabs: { ...current.tabs, ...(patch.tabs || {}) },
    enabled: { ...current.enabled, ...(patch.enabled || {}) },
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
        enabled: { bureau: true, ai: true, rc: true, gst: true },
        scheduleMinutes: 15,
        lastSync: { bureau: null, ai: null, rc: null, gst: null },
        lastError: { bureau: null, ai: null, rc: null, gst: null },
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

module.exports = {
  HEADERS,
  DEFAULT_CONFIG,
  getSheetsConfig,
  saveSheetsConfig,
  ensureSheetsConfigSeeded,
  keyFileStatus,
  getSheetsClient,
  resetSheetsClient,
  ensureHeaders,
  appendRows,
};
