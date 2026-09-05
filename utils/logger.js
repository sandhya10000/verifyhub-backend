'use strict';
const fs = require('fs');
const path = require('path');

// Write to analysis_logs.txt in the backend root directory
const LOG_FILE = path.join(__dirname, '../analysis_logs.txt');

// Track timers per analysis ID in memory: Map<string, { startTime, lastStepTime }>
const timers = new Map();

function logStep(analysisId, stepName, details = null) {
  const idStr = String(analysisId);
  const now = Date.now();
  
  if (!timers.has(idStr)) {
    timers.set(idStr, { startTime: now, lastStepTime: now });
  }
  
  const timing = timers.get(idStr);
  const elapsedStep = now - timing.lastStepTime;
  const elapsedTotal = now - timing.startTime;
  
  timing.lastStepTime = now;
  
  const isoTime = new Date(now).toISOString();
  const detailsStr = details ? ` details=${JSON.stringify(details)}` : '';
  
  // Format: [ANALYSIS <id>] [<ISO timestamp>] STEP=<name> elapsed_step=<X>ms elapsed_total=<Y>ms details=<JSON>
  const logLine = `[ANALYSIS ${idStr}] [${isoTime}] STEP="${stepName}" elapsed_step=${elapsedStep}ms elapsed_total=${elapsedTotal}ms${detailsStr}\n`;
  
  // 1. Print to console
  console.log(logLine.trim());
  
  // 2. Append to file
  try {
    fs.appendFileSync(LOG_FILE, logLine, 'utf8');
  } catch (err) {
    console.error(`[Logger Error] Failed to write to ${LOG_FILE}:`, err.message);
  }
}

module.exports = { logStep };
