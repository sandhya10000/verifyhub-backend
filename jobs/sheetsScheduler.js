'use strict';
// Owns the node-cron schedule for the Sheets export.
//
// The cron ticks every 5 minutes; each tick checks the admin-configured
// interval (scheduleMinutes, default 15) against the last run time and
// only syncs when due. This supports any interval >= 5 min without
// rebuilding cron expressions.
const cron = require('node-cron');
const { getSheetsConfig } = require('../utils/googleSheets');
const { runSheetsSync } = require('./sheetsSync');

let task = null;
let lastRunAt = 0;

async function tick() {
  let mins = 15;
  try {
    const config = await getSheetsConfig();
    mins = Math.min(1440, Math.max(5, Number(config.scheduleMinutes) || 15));
  } catch (e) {
    console.error('[sheets] config load failed, skipping run:', e.message);
    return;
  }
  if (Date.now() - lastRunAt < mins * 60 * 1000) return;
  lastRunAt = Date.now();
  try {
    const results = await runSheetsSync();
    const pushed = Object.values(results).reduce((n, r) => n + (r.pushed || 0), 0);
    if (pushed > 0) console.log(`[sheets] scheduled run pushed ${pushed} rows`);
  } catch (e) {
    console.error('[sheets] scheduled run failed:', e.message);
  }
}

function startSheetsScheduler() {
  if (task) return;
  task = cron.schedule('*/5 * * * *', tick);
  console.log('[sheets] scheduler started (checks every 5 min, interval from Settings)');
}

// Called after an admin changes scheduleMinutes — resets the due timer so
// the new interval takes effect immediately.
function rescheduleSheetsSync() {
  lastRunAt = 0;
  tick().catch((e) => console.error('[sheets] rescheduled run failed:', e.message));
}

module.exports = { startSheetsScheduler, rescheduleSheetsSync };
