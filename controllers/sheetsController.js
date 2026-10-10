'use strict';
// Admin-only Google Sheets export settings + manual sync triggers.
const {
  HEADERS,
  getSheetsConfig,
  saveSheetsConfig,
  keyFileStatus,
} = require('../utils/googleSheets');
const { runSheetsSync } = require('../jobs/sheetsSync');
const CreditReport = require('../models/creditReport');
const AIAnalysis = require('../models/AIAnalysis');
const RcVerification = require('../models/RcVerification');
const GstVerification = require('../models/GstVerification');

// GET /api/admin/integrations/google-sheets
exports.getSheetsSettings = async (req, res) => {
  try {
    const config = await getSheetsConfig();
    const pending = {
      bureau: await CreditReport.countDocuments({ sheetSyncedAt: null }),
      ai: await AIAnalysis.countDocuments({ sheetSyncedAt: null }),
      rc: await RcVerification.countDocuments({ sheetSyncedAt: null }),
      gst: await GstVerification.countDocuments({ sheetSyncedAt: null }),
    };
    res.json({
      success: true,
      data: { config, keyFile: keyFileStatus(), pending, headers: HEADERS },
    });
  } catch (err) {
    console.error('getSheetsSettings Error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch Sheets settings' });
  }
};

// PUT /api/admin/integrations/google-sheets
// Body: { spreadsheetId?, tabs?({bureau,ai,rc,gst}), enabled?({bureau,ai,rc,gst}), scheduleMinutes? }
exports.updateSheetsSettings = async (req, res) => {
  try {
    const patch = {};
    const body = req.body || {};
    if (typeof body.spreadsheetId === 'string' && body.spreadsheetId.trim()) {
      patch.spreadsheetId = body.spreadsheetId.trim();
    }
    if (body.tabs && typeof body.tabs === 'object') {
      const tabs = {};
      for (const k of ['bureau', 'ai', 'rc', 'gst']) {
        if (typeof body.tabs[k] === 'string' && body.tabs[k].trim()) tabs[k] = body.tabs[k].trim();
      }
      if (Object.keys(tabs).length) patch.tabs = tabs;
    }
    if (body.enabled && typeof body.enabled === 'object') {
      const enabled = {};
      for (const k of ['bureau', 'ai', 'rc', 'gst']) {
        if (typeof body.enabled[k] === 'boolean') enabled[k] = body.enabled[k];
      }
      if (Object.keys(enabled).length) patch.enabled = enabled;
    }
    const mins = Number(body.scheduleMinutes);
    if (Number.isFinite(mins)) patch.scheduleMinutes = Math.min(1440, Math.max(5, Math.floor(mins)));
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid Sheets settings provided' });
    }
    // If the interval changed, rebuild the cron schedule on the fly.
    const prev = await getSheetsConfig();
    const config = await saveSheetsConfig(patch);
    if (patch.scheduleMinutes && patch.scheduleMinutes !== prev.scheduleMinutes) {
      try {
        require('../jobs/sheetsScheduler').rescheduleSheetsSync();
      } catch (e) {
        console.error('[sheets] reschedule failed:', e.message);
      }
    }
    res.json({ success: true, data: { config, keyFile: keyFileStatus() } });
  } catch (err) {
    console.error('updateSheetsSettings Error:', err);
    res.status(500).json({ success: false, message: 'Could not update Sheets settings' });
  }
};

// POST /api/admin/integrations/google-sheets/sync-now
// Body: { backfill?: boolean } — backfill ignores the watermark (up to 500/tab/run).
exports.triggerSheetsSync = async (req, res) => {
  try {
    const backfill = Boolean(req.body?.backfill);
    const results = await runSheetsSync({ backfill });
    res.json({ success: true, data: results });
  } catch (err) {
    console.error('triggerSheetsSync Error:', err);
    res.status(500).json({ success: false, message: 'Sheets sync failed to start' });
  }
};
