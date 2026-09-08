'use strict';
// ============================================================================
// reportRenderer.js — Orchestrates classification, chart building, and
// EJS template rendering from a single structured data object.
// Called synchronously after the Claude extraction tool call completes.
// Expected time: 5-20ms (all pure JS + URL string building, no I/O).
// ============================================================================
const ejs  = require('ejs');
const path = require('path');

const {
  annotateAccounts,
  computePortfolioStats,
  computeProfileNote,
  addSeverityToRiskFactors,
  rerankRiskFactors,
  dpdCodeToColor,
  formatINR,
  computeEnquiryCounts,
} = require('./creditClassifier');

const charts = require('./chartBuilder');
const { LOGO_DATA_URI } = require('./brandAssets');

const TEMPLATE_PATH = path.join(__dirname, '../views/creditReport.ejs');

/**
 * renderCreditReport
 * @param {object} data — raw output from the expanded ANALYSIS_TOOL
 * @returns {Promise<string>} — complete, self-contained HTML string
 */
async function renderCreditReport(data) {
  // 1. Annotate accounts with deterministic classification
  const accounts = annotateAccounts(data.accounts || []);

  // 2. Portfolio-level aggregates
  const stats = computePortfolioStats(accounts);

  // 3. Profile note — explains zero-balance stat boxes for fully-closed portfolios.
  //    Returns null when live balances are present (no note needed).
  const profileNote = computeProfileNote(stats);

  // 4. Deterministically compute enquiry window counts from the raw dates array.
  //    This replaces the Claude-extracted enquiries_6m / enquiries_12m fields,
  //    which were unreliable for large enquiry lists (50+ entries).
  const enquiryCounts = computeEnquiryCounts(
    data.enquiries || [],
    data.report_date || null
  );

  // 5. Infer severity for each risk factor from annotated accounts, then re-rank
  //    by active relevance (active-account issues outrank closed-account issues
  //    of the same severity; high-enquiry-volume patterns are boosted accordingly).
  const riskFactorsWithSeverity = addSeverityToRiskFactors(data.risk_factors || [], accounts);
  const riskFactors = rerankRiskFactors(riskFactorsWithSeverity, accounts, enquiryCounts);

  // 5. Build all chart URLs
  const score = data.credit_score || 0;
  const projectedScores = Array.isArray(data.projected_scores) && data.projected_scores.length === 4
    ? data.projected_scores
    : [score, score + 10, score + 20, score + 30];

  const dpdCharts = {};
  for (const acct of accounts) {
    if ((acct.max_dpd || 0) > 0 && (acct.dpd_history || []).length > 0) {
      dpdCharts[acct.masked_account_number] = charts.dpdHistoryBarUrl(acct);
    }
  }

  const chartUrls = {
    scoreGauge:         charts.scoreGaugeUrl(score),
    portfolioMix:       charts.portfolioMixUrl(stats),
    riskSeverity:       charts.riskSeverityDistributionUrl(stats.severityCounts),
    accountsByType:     charts.accountsByTypeUrl(stats.typeMap),
    accountsByLender:   charts.accountsByLenderUrl(stats.lenderMap),
    outstandingVsSanct: charts.outstandingVsSanctionedUrl(accounts),
    riskMap:            charts.riskMapUrl(accounts),
    projectedScore:     charts.projectedScoreUrl(projectedScores),
    enquiryTimeline:    charts.enquiryTimelineUrl(data.enquiries || [], data.report_date || null),
    dpdCharts,
  };

  // 6. Render the EJS template
  const html = await ejs.renderFile(
    TEMPLATE_PATH,
    {
      data,
      accounts,
      enquiries:       data.enquiries    || [],
      riskFactors,
      stats,
      profileNote,     // null for live-balance clients, banner string for zero-balance portfolios
      enquiryCounts,   // deterministic 6m/12m counts — use these in template, NOT data.enquiries_12m
      chartUrls,
      projectedScores,
      dpdCodeToColor,
      formatINR,
      logoDataUri: LOGO_DATA_URI,
    },
    { async: true }
  );

  return html;
}

module.exports = { renderCreditReport };
