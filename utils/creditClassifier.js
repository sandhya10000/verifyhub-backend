'use strict';
// ============================================================================
// creditClassifier.js — Pure, deterministic, zero-LLM classification logic.
// All functions are pure (no side effects, no external I/O).
// Thresholds match the SEVERITY RULES and ACCOUNT HEALTH SCORE GUIDANCE
// sections in the original ai-analysis-prompt.txt exactly.
// ============================================================================

const SEVERITY_COLORS = {
  CRITICAL: '#dc3545',
  HIGH:     '#fd7e14',
  MEDIUM:   '#ffc107',
  LOW:      '#28a745',
};

// Status strings that map to CRITICAL regardless of DPD
const CRITICAL_STATUSES = new Set([
  'written-off', 'write-off', 'post write-off settlement', 'post write-off',
  'settled', 'doubtful', 'loss', 'sub-standard', 'sub standard', 'willful default',
  'suit filed',
]);

// DPD code strings that map to CRITICAL
const CRITICAL_DPD_CODES = new Set(['sub', 'dbt', 'lss', '090', '120', '150', '180']);

// Secured account types for portfolio-mix calculations
const SECURED_TYPES = new Set([
  'home loan', 'auto loan', 'car loan', 'two wheeler loan', 'two-wheeler loan',
  'gold loan', 'property loan', 'mortgage', 'vehicle loan',
  'business loan secured', 'loan against property', 'lap',
]);

// ---------------------------------------------------------------------------
// classifyAccount
// Returns severity (CRITICAL/HIGH/MEDIUM/LOW), a 0-100 health score, and
// the derived utilization percentage.
// ---------------------------------------------------------------------------
function classifyAccount(acct) {
  const sanctioned       = acct.sanctioned_amount  || 0;
  const balance          = acct.current_balance    || 0;
  const overdue          = acct.overdue_amount     || 0;
  const writtenOff       = acct.written_off_amount || 0;
  const maxDpd           = acct.max_dpd            || 0;
  const suitFiled        = acct.suit_filed         || false;
  const dpdHistory       = acct.dpd_history        || [];
  const statusLower      = (acct.status || '').toLowerCase().trim();

  // ── Utilization ──────────────────────────────────────────────────────────
  const utilPct = sanctioned > 0 ? Math.round((balance / sanctioned) * 100) : 0;

  // ── CRITICAL DPD code in history ─────────────────────────────────────────
  const hasCriticalCode = dpdHistory.some(
    (h) => CRITICAL_DPD_CODES.has((h.value || '').toLowerCase())
  );

  // ── Severity ─────────────────────────────────────────────────────────────
  let severity;
  if (
    writtenOff > 0 ||
    suitFiled ||
    CRITICAL_STATUSES.has(statusLower) ||
    maxDpd >= 90 ||
    hasCriticalCode ||
    overdue > 0 ||
    utilPct > 100
  ) {
    severity = 'CRITICAL';
  } else if (maxDpd >= 30 || utilPct >= 60) {
    severity = 'HIGH';
  } else {
    const gapMonths = dpdHistory.filter(
      (h) => h.value === 'NR' || h.value === 'XXX'
    ).length;
    severity = (maxDpd >= 1 || gapMonths >= 3) ? 'MEDIUM' : 'LOW';
  }

  // ── Health Score (0-100) ──────────────────────────────────────────────────
  // Start at 100, deduct for negative signals.
  let health = 100;

  // Written-off / loss accounts
  if (writtenOff > 0 || statusLower.includes('write-off') || statusLower.includes('loss')) {
    health -= 80;
  }
  // Settled / doubtful / sub-standard
  if (['settled', 'doubtful', 'sub-standard', 'sub standard'].includes(statusLower)) {
    health -= 60;
  }
  // Active overdue
  if (overdue > 0) health -= 40;

  // DPD bucket deductions
  if      (maxDpd >= 180) health -= 50;
  else if (maxDpd >= 90)  health -= 40;
  else if (maxDpd >= 60)  health -= 25;
  else if (maxDpd >= 30)  health -= 15;
  else if (maxDpd >= 1)   health -= 5;

  // Utilization deductions
  if      (utilPct > 100)  health -= 20;
  else if (utilPct >= 90)  health -= 12;
  else if (utilPct >= 75)  health -= 8;
  else if (utilPct >= 60)  health -= 4;

  // Suit filed
  if (suitFiled) health -= 15;

  // Reporting gaps
  const gapMonths = dpdHistory.filter((h) => h.value === 'NR' || h.value === 'XXX').length;
  if      (gapMonths >= 6) health -= 15;
  else if (gapMonths >= 3) health -= 8;

  health = Math.max(0, Math.min(100, Math.round(health)));

  return { severity, healthScore: health, severityColor: SEVERITY_COLORS[severity], utilPct };
}

// ---------------------------------------------------------------------------
// dpdCodeToColor — maps a DPD code to a background color for the ph-cell grid
// ---------------------------------------------------------------------------
function dpdCodeToColor(code) {
  const c = (code || '').toLowerCase().trim();
  if (c === 'ok' || c === '000') return '#28a745';
  if (c === '030')               return '#ffc107';
  if (c === '060')               return '#fd7e14';
  if (['090','120','150','180','sub','dbt','lss'].includes(c)) return '#dc3545';
  return '#adb5bd'; // NR / XXX / unknown
}

// ---------------------------------------------------------------------------
// classifyEnquiryCount — returns a band label for enquiry frequency
// ---------------------------------------------------------------------------
function classifyEnquiryCount(count) {
  if (count == null) return null;
  if (count === 0)   return 'Excellent';
  if (count <= 2)    return 'Good';
  if (count <= 5)    return 'Fair';
  return 'Poor';
}

// ---------------------------------------------------------------------------
// annotateAccounts
// Returns a new array where each account has _severity, _healthScore,
// _severityColor, and _utilPct added as computed properties.
// ---------------------------------------------------------------------------
function annotateAccounts(accounts) {
  return (accounts || []).map((acct) => {
    const c = classifyAccount(acct);
    return {
      ...acct,
      _severity:      c.severity,
      _healthScore:   c.healthScore,
      _severityColor: c.severityColor,
      _utilPct:       c.utilPct,
    };
  });
}

// ---------------------------------------------------------------------------
// computePortfolioStats
// Derives all aggregate numbers needed by Section 01 and Section 05.
// Must be called AFTER annotateAccounts so _severity is available.
// ---------------------------------------------------------------------------
function computePortfolioStats(accounts) {
  let totalOutstanding     = 0;
  let totalOverdue         = 0;
  let totalSanctioned      = 0;
  let totalWrittenOff      = 0;
  let securedOutstanding   = 0;
  let unsecuredOutstanding = 0;
  // Lifetime sanctioned split — useful when all balances are zero (closed portfolio)
  let securedSanctioned    = 0;
  let unsecuredSanctioned  = 0;
  const typeMap        = {};
  const lenderMap      = {};
  const severityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };

  for (const acct of accounts) {
    totalOutstanding += acct.current_balance    || 0;
    totalOverdue     += acct.overdue_amount     || 0;
    totalSanctioned  += acct.sanctioned_amount  || 0;
    totalWrittenOff  += acct.written_off_amount || 0;

    const typeLower = (acct.account_type || '').toLowerCase();
    if (SECURED_TYPES.has(typeLower)) {
      securedOutstanding  += acct.current_balance   || 0;
      securedSanctioned   += acct.sanctioned_amount || 0;
    } else {
      unsecuredOutstanding += acct.current_balance   || 0;
      unsecuredSanctioned  += acct.sanctioned_amount || 0;
    }

    const type   = acct.account_type || 'Other';
    const lender = acct.lender || 'Unknown';
    typeMap[type]     = (typeMap[type]     || 0) + 1;
    lenderMap[lender] = (lenderMap[lender] || 0) + 1;

    if (acct._severity) severityCounts[acct._severity]++;
  }

  const activeAccounts = accounts.filter(
    (a) => (a.status || '').toLowerCase() === 'active'
  ).length;

  // True when at least one account still carries a live balance
  const hasActiveBalance = totalOutstanding > 0;

  // Utilization: credit cards only
  const cards = accounts.filter(
    (a) => (a.account_type || '').toLowerCase().includes('credit card')
  );
  const cardLimit      = cards.reduce((s, a) => s + (a.sanctioned_amount || 0), 0);
  const cardBalance    = cards.reduce((s, a) => s + (a.current_balance   || 0), 0);
  const utilizationPct = cardLimit > 0 ? Math.round((cardBalance / cardLimit) * 100) : 0;

  // Oldest vintage year
  const openDates = accounts
    .map((a) => a.opened_date)
    .filter(Boolean)
    .map((d) => {
      const parts = d.split('/');
      return parts.length === 3 ? new Date(`${parts[2]}-${parts[1]}-${parts[0]}`) : null;
    })
    .filter((d) => d && !isNaN(d));
  const oldestVintage = openDates.length
    ? new Date(Math.min(...openDates.map((d) => d.getTime()))).getFullYear()
    : null;

  return {
    totalAccounts: accounts.length,
    activeAccounts,
    totalOutstanding,
    totalOverdue,
    totalSanctioned,
    totalWrittenOff,
    securedOutstanding,
    unsecuredOutstanding,
    securedSanctioned,    // lifetime sanctioned — shown when hasActiveBalance is false
    unsecuredSanctioned,  // lifetime sanctioned — shown when hasActiveBalance is false
    hasActiveBalance,
    utilizationPct,
    oldestVintage,
    typeMap,
    lenderMap,
    severityCounts,
  };
}

// ---------------------------------------------------------------------------
// computeProfileNote
// Returns a short, human-readable banner sentence that gives context when the
// stat numbers in Section 01 look like zeros.  Returns null when the numbers
// already tell the story (i.e. the client has live outstanding balances).
//
// Call this AFTER computePortfolioStats so the stats object is already built.
// ---------------------------------------------------------------------------
function computeProfileNote(stats) {
  if (stats.hasActiveBalance) {
    // Numbers are live and meaningful — no explanatory note needed.
    return null;
  }

  if (stats.activeAccounts === 0) {
    // Every account is fully closed and at zero balance.
    return (
      'This client currently has no active credit lines — all accounts below are ' +
      'historical records, fully closed with zero balance owed today. ' +
      'Exposure figures reflect lifetime sanctioned amounts, not current obligations.'
    );
  }

  // Edge case: one or more accounts are still technically "open" but carry
  // zero balance (e.g. a credit card that is open but fully paid off).
  return (
    'All accounts currently show a zero outstanding balance. ' +
    `${stats.activeAccounts} account${stats.activeAccounts === 1 ? ' is' : 's are'} ` +
    'still open but fully paid — exposure figures reflect lifetime sanctioned amounts.'
  );
}

// ---------------------------------------------------------------------------
// addSeverityToRiskFactors
// Infers severity for each risk factor by matching lender names against
// the annotated accounts. Falls back to position-based ranking.
// ---------------------------------------------------------------------------
function addSeverityToRiskFactors(riskFactors, annotatedAccounts) {
  const SEVERITY_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

  // Build: lender name (lowercase) → worst severity
  const lenderSeverity = {};
  for (const a of annotatedAccounts) {
    const key      = (a.lender || '').toLowerCase();
    const existing = lenderSeverity[key];
    if (!existing || SEVERITY_ORDER.indexOf(a._severity) > SEVERITY_ORDER.indexOf(existing)) {
      lenderSeverity[key] = a._severity;
    }
  }

  return (riskFactors || []).map((rf, i) => {
    const matchedKey = Object.keys(lenderSeverity).find(
      (k) => rf.title.toLowerCase().includes(k)
    );
    const severity = matchedKey
      ? lenderSeverity[matchedKey]
      : (i === 0 ? 'CRITICAL' : i === 1 ? 'HIGH' : 'MEDIUM');
    return { ...rf, severity, _color: SEVERITY_COLORS[severity] };
  });
}

// ---------------------------------------------------------------------------
// rerankRiskFactors
// Re-sorts riskFactors (after addSeverityToRiskFactors has run) so that
// actively-relevant issues outrank historically-severe-but-resolved ones.
//
// Scoring logic:
//   Base score from severity:   CRITICAL=40, HIGH=30, MEDIUM=20, LOW=10
//   Active account bonus:       +25   (lender matched → account is Active)
//   Closed account penalty:     -10   (lender matched → account is Closed/Settled/Written-off)
//   No account match, THREE sub-cases:
//     (i)  Enquiry-related factor (title/explanation contains enquiry keywords)
//          AND enquiries_12m >= 15 → +20 (genuine ongoing risk, boost it)
//     (ii) Ungrounded / discrepancy-flagged factor (contains mismatch-signal
//          keywords like "no active credit card", "may reference", "not applicable",
//          "bureau flags", "closed or unreported") → -15 (push to bottom;
//          it's an unconfirmed claim, not a verified risk)
//     (iii) Other portfolio-wide pattern (unsecured mix, etc.) → 0 (rank by
//          severity alone, no bonus or penalty)
//
// Net effects on an all-closed portfolio with 30 enquiries in 12m:
//   Active CRITICAL account   : 40+25 = 65  (highest)
//   Active HIGH account        : 30+25 = 55
//   Enquiry-volume factor (MED): 20+20 = 40  > closed CRITICAL (40-10=30) ✓
//   Closed CRITICAL            : 40-10 = 30
//   Portfolio-wide MEDIUM      : 20+ 0 = 20
//   Discrepancy-flagged MEDIUM : 20-15 =  5  (bottom) ✓
// ---------------------------------------------------------------------------

function rerankRiskFactors(riskFactors, annotatedAccounts, enquiryCounts) {
  const SEVERITY_SCORE = { CRITICAL: 40, HIGH: 30, MEDIUM: 20, LOW: 10 };

  // Build: lender name (lowercase) → account status
  const lenderStatus = {};
  for (const a of annotatedAccounts) {
    const key = (a.lender || '').toLowerCase();
    // Prefer Active over everything else when a lender has multiple accounts
    const existing = lenderStatus[key];
    if (!existing || (a.status || '').toLowerCase() === 'active') {
      lenderStatus[key] = (a.status || '').toLowerCase();
    }
  }

  const enquiries12m        = (enquiryCounts && enquiryCounts.enquiries_12m) || 0;
  const HIGH_ENQUIRY_THRESHOLD = 15;

  // Keywords that identify an enquiry/credit-shopping risk factor
  const ENQUIRY_KEYWORDS = [
    'enquiry', 'enquiries', 'inquiry', 'inquiries',
    'credit shopping', 'credit-shopping', 'credit hungry', 'credit-hungry',
    'hard pull', 'hard pulls', 'applications', 'credit applications',
  ];

  // Keywords that signal this is a discrepancy-flagged / ungrounded factor
  // (i.e. Claude has already noted it may not apply to this client)
  const DISCREPANCY_KEYWORDS = [
    'no active credit card', 'no credit card', 'may reference',
    'closed or unreported', 'not applicable', 'bureau flags',
    'bureau flag', 'may not be currently applicable', 'discrepancy',
    'unreported facility',
  ];

  const scored = riskFactors.map((rf) => {
    const base       = SEVERITY_SCORE[rf.severity] || 20;
    const searchText = ((rf.title || '') + ' ' + (rf.explanation || '')).toLowerCase();

    // Step 1: try to match a known lender name
    const matchedKey = Object.keys(lenderStatus).find((k) => k && searchText.includes(k));

    let bonus = 0;

    if (matchedKey) {
      // Account-specific factor — boost if active, penalise if closed/resolved
      bonus = lenderStatus[matchedKey] === 'active' ? +25 : -10;
    } else {
      // No lender match — classify by content
      const isEnquiryRelated     = ENQUIRY_KEYWORDS.some((kw) => searchText.includes(kw));
      const isDiscrepancyFlagged = DISCREPANCY_KEYWORDS.some((kw) => searchText.includes(kw));

      if (isDiscrepancyFlagged) {
        // Ungrounded / possibly-inapplicable bureau factor → push to bottom
        bonus = -15;
      } else if (isEnquiryRelated && enquiries12m >= HIGH_ENQUIRY_THRESHOLD) {
        // Genuine high-volume enquiry risk → boost above closed-account items
        bonus = +20;
      }
      // else: other portfolio-wide pattern (unsecured mix, vintage, etc.) → bonus stays 0
    }

    return { rf, score: base + bonus };
  });

  // Sort descending by score; preserve original order as tiebreaker (stable sort)
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.rf);
}

// ---------------------------------------------------------------------------
// formatINR — formats a number as ₹X,XX,XXX Indian locale
// ---------------------------------------------------------------------------
function formatINR(n) {
  if (n == null || isNaN(n)) return '₹0';
  return '₹' + Number(n).toLocaleString('en-IN');
}

// ---------------------------------------------------------------------------
// computeEnquiryCounts
// Deterministic (no-LLM) count of enquiries within the last 6 and 12 months.
//
// @param  {Array}  enquiries  — raw enquiries array from Claude extraction;
//                               each item must have a `date` field (DD/MM/YYYY).
// @param  {string} reportDate — report generation date in DD/MM/YYYY format.
// @returns {{ enquiries_6m: number, enquiries_12m: number }}
//
// Boundary behaviour: an enquiry whose date falls EXACTLY on the boundary
// (i.e. exactly 180 or 365 days before reportDate) is counted as within the
// window (inclusive lower bound).
//
// Malformed or missing dates are silently skipped — they never cause a crash.
// ---------------------------------------------------------------------------
function computeEnquiryCounts(enquiries, reportDate) {
  const fallback = { enquiries_6m: 0, enquiries_12m: 0 };

  // Parse a DD/MM/YYYY string to a UTC midnight Date, or null on failure.
  function parseDMY(str) {
    if (!str || typeof str !== 'string') return null;
    const parts = str.trim().split('/');
    if (parts.length !== 3) return null;
    const [dd, mm, yyyy] = parts;
    const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
    // Validate: ensure no field rolled over (e.g. 31/02 → March)
    if (
      isNaN(d.getTime()) ||
      d.getUTCDate()     !== Number(dd) ||
      d.getUTCMonth()    !== Number(mm) - 1 ||
      d.getUTCFullYear() !== Number(yyyy)
    ) return null;
    return d;
  }

  const refDate = parseDMY(reportDate);
  if (!refDate) return fallback; // can't compute without a valid report date

  const MS_PER_DAY = 86400000;
  const cutoff6m   = new Date(refDate.getTime() - 180 * MS_PER_DAY);
  const cutoff12m  = new Date(refDate.getTime() - 365 * MS_PER_DAY);

  let count6m  = 0;
  let count12m = 0;

  for (const enq of (enquiries || [])) {
    const enqDate = parseDMY(enq && enq.date);
    if (!enqDate) continue; // skip malformed/missing dates

    if (enqDate >= cutoff12m && enqDate <= refDate) count12m++;
    if (enqDate >= cutoff6m  && enqDate <= refDate) count6m++;
  }

  return { enquiries_6m: count6m, enquiries_12m: count12m };
}

module.exports = {
  classifyAccount,
  annotateAccounts,
  computePortfolioStats,
  computeProfileNote,
  addSeverityToRiskFactors,
  rerankRiskFactors,
  dpdCodeToColor,
  classifyEnquiryCount,
  computeEnquiryCounts,
  formatINR,
  SEVERITY_COLORS,
};
