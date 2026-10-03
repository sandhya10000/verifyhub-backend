'use strict';
// ============================================================================
// services/cibilParser.js  v2
// Deterministic (zero-LLM) parser for TransUnion CIBIL PDF text output.
//
// Key observations from actual Ankur PDF text (pdf-parse, tabs→spaces):
//   • Title lines: "KRAZYBEEPersonal LoanKB190805ZXCRZIndividual" (no spaces)
//   • Financial lines: "CURRENT BALANCE4098EMI AMOUNT-" (value glued to label)
//   • DPD year rows: "2020300270239209178149" (year + values run together)
//   • MONTH/YEAR artifact lines appear between year rows — must be skipped
//   • Blank DPD cells are dropped by pdf-parse — don't validate count
//   • Enquiry: single pass of member+date rows, then ENQUIRY PURPOSE, then purposes
//   • Score 712 is a standalone line mid-document (after account blocks start)
// ============================================================================

// ── Helpers ────────────────────────────────────────────────────────────────

function splitLines(text) {
  return text.split(/\r?\n/).map(l => l.replace(/\t/g, ' ').trimEnd());
}

function parseAmount(s) {
  if (!s || s.trim() === '-') return null;
  const n = parseFloat(s.replace(/,/g, '').trim());
  return isNaN(n) ? null : n;
}

function ymdToDmy(ymd) {
  if (!ymd) return null;
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}

function monthShort(m) { // m: 1-12
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1];
}

function scoreBand(score) {
  if (score >= 800) return 'Excellent';
  if (score >= 750) return 'Good';
  if (score >= 700) return 'Fair';
  if (score >= 650) return 'Below Average';
  return 'Poor';
}

// ── Account types (longest first to avoid partial matches) ─────────────────
const ACCT_TYPES = [
  'Business Loan - Unsecured', 'Business Loan - Secured',
  'Business Loan \u2013 General',   'Business Loan - General',
  'Auto Loan (Personal)',       'Two-wheeler Loan', 'Two Wheeler Loan',
  'Used Car Loan',  'Property Loan',  'Personal Loan',  'Consumer Loan',
  'Credit Card',    'Gold Loan',      'Home Loan',       'Housing Loan',
  'Education Loan', 'Microfinance',   'Kisan Credit Card',
  'Secured Credit Card', 'Loan on Credit Card', 'Overdraft',
  'Agriculture Loan', 'Commercial Vehicle Loan', 'Fleet Loan', 'Staff Loan',
];

// ── extractHeaderFields ────────────────────────────────────────────────────
// Scans the ENTIRE document so the score (which appears mid-doc) is captured.
function extractHeaderFields(lines) {
  const header = {
    client_name: null, credit_score: null, score_band: null,
    report_date: null, pan: null, dob: null, bureau_control_no: null,
  };
  let pastAccountInfo = false;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l === 'ACCOUNT INFORMATION') pastAccountInfo = true;

    // Report date — "DATE:  Tue  Aug  04  2026"
    if (!pastAccountInfo && /^DATE:\s/.test(l)) {
      const m = l.match(/(\w{3})\s+(\d{1,2})\s+(\d{4})$/);
      if (m) {
        const mmap = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
                      jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
        const mm = mmap[m[1].toLowerCase()];
        if (mm) header.report_date = `${m[2].padStart(2,'0')}/${mm}/${m[3]}`;
      }
    }

    // Control number
    if (!pastAccountInfo) {
      const m = l.match(/^CONTROL\s+NUMBER:\s*(\d+)/);
      if (m) header.bureau_control_no = m[1];
    }

    // Name + DOB — "ANKUR GIRISHBHAI PATEL1982-11-27Male"
    if (!pastAccountInfo && !header.client_name) {
      const m = l.match(/^([A-Z][A-Z\s]+?)(\d{4}-\d{2}-\d{2})(Male|Female)?$/);
      if (m) {
        const [yy, mm2, dd] = m[2].split('-');
        header.dob = `${dd}/${mm2}/${yy}`;
        header.client_name = m[1].trim();
      }
    }

    // PAN
    if (!pastAccountInfo && /INCOME\s+TAX\s+ID\s+NUMBER/i.test(l)) {
      const m = l.match(/[A-Z]{5}[0-9]{4}[A-Z]/);
      if (m) header.pan = m[0];
    }

    // CIBIL score — standalone 3-digit number anywhere in doc
    if (/^\d{3}$/.test(l)) {
      const n = parseInt(l, 10);
      if (n >= 300 && n <= 900 && !header.credit_score) {
        header.credit_score = n;
        header.score_band   = scoreBand(n);
      }
    }
  }

  return header;
}

// ── parseTitleLine ─────────────────────────────────────────────────────────
// Title line: "KRAZYBEEPersonal LoanKB190805ZXCRZIndividual" (no spaces between fields)
// Strategy: strip ownership suffix → find account type → split lender / acctNum.
function parseTitleLine(raw) {
  const ownerRe   = /(Individual|Joint|Guarantor)$/i;
  const ownerMatch = raw.match(ownerRe);
  const ownership  = ownerMatch ? ownerMatch[1] : 'Individual';
  const withoutOwn = ownerMatch ? raw.slice(0, ownerMatch.index).trimEnd() : raw.trim();

  for (const type of ACCT_TYPES) {
    const idx = withoutOwn.toLowerCase().indexOf(type.toLowerCase());
    if (idx >= 0) {
      const lender  = withoutOwn.slice(0, idx).trim();
      const acctNum = withoutOwn.slice(idx + type.length).trim() || null;
      return { lender: lender || withoutOwn, accountType: type, ownership, acctNum };
    }
  }

  // Fallback
  return { lender: withoutOwn, accountType: 'Unknown', ownership, acctNum: null };
}

// ── parseAccountBlock ──────────────────────────────────────────────────────
function parseAccountBlock(block, warnings) {
  if (block.length < 3) return null;

  const { lender, accountType, ownership, acctNum } = parseTitleLine(block[0].trim());

  let creditLimit     = null, sanctionedAmount = null, currentBalance = null;
  let overdueAmount   = null, emiAmount        = null;
  let writtenOffTotal = null, writtenOffPrinc  = null;
  let highCredit      = null;
  let dateOpened      = null, dateClosed       = null;
  let dateLastPayment = null;
  let payStartDate    = null, payEndDate       = null;
  let suitFiled       = false, status          = null;

  for (const line of block) {
    const t = line.trim();
    let m;

    // Financial fields — values run directly against the label (no space)
    if ((m = t.match(/CREDIT\s+LIMIT\s*(-|\d[\d,]*)/))     && m[1] !== '-') creditLimit     = parseAmount(m[1]);
    if ((m = t.match(/HIGH\s+CREDIT\s*(-|\d[\d,]*)/))      && m[1] !== '-') highCredit      = parseAmount(m[1]);
    if ((m = t.match(/Sanctioned\s+Amount\s*(-|\d[\d,]*)/i)) && m[1] !== '-') sanctionedAmount = parseAmount(m[1]);
    if ((m = t.match(/CURRENT\s+BALANCE\s*(-|\d[\d,]*)/))  && m[1] !== '-') currentBalance  = parseAmount(m[1]);
    if ((m = t.match(/AMOUNT\s+OVERDUE\s*(-|\d[\d,]*)/))   && m[1] !== '-') overdueAmount   = parseAmount(m[1]);
    if ((m = t.match(/EMI\s+AMOUNT\s*(-|\d[\d,]*)/))       && m[1] !== '-') emiAmount       = parseAmount(m[1]);
    if ((m = t.match(/WRITTEN[- ]OFF\s+AMOUNT\(TOTAL\)\s*(-|\d[\d,]*)/i))     && m[1] !== '-') writtenOffTotal = parseAmount(m[1]);
    if ((m = t.match(/WRITTEN[- ]OFF\s+AMOUNT\(PRINCIPAL\)\s*(-|\d[\d,]*)/i)) && m[1] !== '-') writtenOffPrinc = parseAmount(m[1]);

    // Dates
    if ((m = t.match(/DATE\s+OPENED\/DISBURSED\s*(\d{4}-\d{2}-\d{2})/)))       dateOpened      = ymdToDmy(m[1]);
    if ((m = t.match(/DATE\s+CLOSED\s*(\d{4}-\d{2}-\d{2})/)))                   dateClosed      = ymdToDmy(m[1]);
    if ((m = t.match(/DATE\s+OF\s+LAST\s+PAYMENT\s*(\d{4}-\d{2}-\d{2})/)))      dateLastPayment = ymdToDmy(m[1]);
    if ((m = t.match(/PAYMENT\s+START\s+DATE\s*(\d{4}-\d{2}-\d{2})/)))          payStartDate    = m[1];
    if ((m = t.match(/PAYMENT\s+END\s+DATE\s*(\d{4}-\d{2}-\d{2})/)))            payEndDate      = m[1];
    if (/SUIT\s+FILED/i.test(t) && /yes/i.test(t))                               suitFiled       = true;
    if ((m = t.match(/CREDIT\s+FACILITY\s+STATUS\s*(Active|Closed|Settled|Written-off)/i))) status = m[1];
  }

  if (!status) status = dateClosed ? 'Closed' : 'Active';

  const effectiveSanctioned = sanctionedAmount ?? creditLimit ?? highCredit ?? null;

  const acctLabel = acctNum || lender;
  const { dpdHistory, maxDpd } = parseDpdHistory(block, payStartDate, payEndDate);

  return {
    lender:                lender || 'Unknown',
    masked_account_number: acctNum || '',
    account_type:          accountType,
    ownership,
    opened_date:           dateOpened  || null,
    closed_date:           dateClosed  || null,
    status,
    sanctioned_amount:     effectiveSanctioned,
    current_balance:       currentBalance  ?? 0,
    overdue_amount:        overdueAmount   ?? 0,
    emi_amount:            emiAmount       || null,
    written_off_amount:    writtenOffTotal ?? 0,
    principal_written_off: writtenOffPrinc ?? null,
    suit_filed:            suitFiled,
    max_dpd:               maxDpd,
    dpd_history:           dpdHistory,
    _date_last_payment:    dateLastPayment,
  };
}

// ── parseDpdHistory ────────────────────────────────────────────────────────
// Blank DPD cells are DROPPED by pdf-parse, so token count ≠ expected months.
// We assign tokens from newest (end date) backwards — any missing slots stay empty.
function parseDpdHistory(block, payStartStr, payEndStr) {
  const empty = { dpdHistory: [], maxDpd: 0 };
  if (!payStartStr || !payEndStr) return empty;

  const [sy, sm] = payStartStr.split('-').map(Number);
  const [ey, em] = payEndStr.split('-').map(Number);
  const expectedMonths = (ey - sy) * 12 + (em - sm) + 1;
  if (expectedMonths <= 0 || expectedMonths > 500) return empty;

  // Locate grid (PAYMENT HISTORY … COLLATERAL)
  let gridStart = -1, gridEnd = block.length;
  for (let i = 0; i < block.length; i++) {
    const t = block[i].trim();
    if (/PAYMENT\s+HISTORY/i.test(t))      gridStart = i + 1;
    if (/^COLLATERAL$/i.test(t) && gridStart >= 0) { gridEnd = i; break; }
  }
  if (gridStart < 0) return empty;

  const tokens = [];
  for (const line of block.slice(gridStart, gridEnd)) {
    const t = line.trim();
    if (!t) continue;
    if (/^(DEC|NOV|OCT|SEP|AUG|JUL|JUN|MAY|APR|MAR|FEB|JAN)/i.test(t)) continue;
    if (/DAYS\s+PAST\s+DUE/i.test(t))    continue;
    if (/PAYMENT\s+(START|END|HISTORY)/i.test(t)) continue;
    if (/ASSET\s+CLASSIFICATION/i.test(t)) continue;
    if (/^(MONTH|YEAR)$/.test(t))         continue; // PDF sidebar artifact
    if (/^(COLLATERAL|Default|SUIT|CREDIT\s+FACILITY|WRITTEN|SETTLEMENT)/i.test(t)) break;

    // Year-prefixed line: "2020300270239209178149"
    const yearMatch = t.match(/^(\d{4})(.*)/);
    if (yearMatch) {
      const year = parseInt(yearMatch[1], 10);
      if (year >= 2000 && year <= 2050) {
        tokens.push(...tokeniseDpdRun(yearMatch[2]));
        continue;
      }
    }

    // Standalone token
    if (/^(\d{1,4}|STD|SMA|SUB|DBT|LSS|XXX|NR)$/i.test(t)) {
      tokens.push(normaliseDpdValue(t));
    }
  }

  if (tokens.length === 0) return empty;

  // Assign newest-first to months descending from end date
  const history = [];
  let curYear = ey, curMonth = em;
  for (const token of tokens) {
    if (curYear < sy || (curYear === sy && curMonth < sm)) break;
    history.push({ month: `${monthShort(curMonth)}-${curYear}`, value: token });
    curMonth--;
    if (curMonth < 1) { curMonth = 12; curYear--; }
  }

  return { dpdHistory: history, maxDpd: computeMaxDpd(tokens) };
}

function normaliseDpdValue(raw) {
  const v = (raw || '').trim().toUpperCase();
  if (v === '0' || v === '000' || v === 'OK') return '000';
  if (['STD','SMA','SUB','DBT','LSS','XXX','NR'].includes(v)) return v;
  const n = parseInt(v, 10);
  return isNaN(n) ? v : (n <= 0 ? '000' : String(n));
}

function tokeniseDpdRun(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    let matched = false;
    // Text codes first (3 chars)
    for (const code of ['STD','SMA','SUB','DBT','LSS','XXX']) {
      if (s.slice(i, i + 3).toUpperCase() === code) {
        tokens.push(normaliseDpdValue(code)); i += 3; matched = true; break;
      }
    }
    // 2-char codes
    if (!matched && s.slice(i, i + 2).toUpperCase() === 'NR') {
      tokens.push('NR'); i += 2; matched = true;
    }
    if (matched) continue;

    // Numeric run — CIBIL DPD values are typically 1-3 digits:
    //   0   → 0 days past due
    //   1-9 → single digit
    //   10-99 → two digits
    //   100-365 → three digits
    //
    // Problem: "1188757260" must parse as 11,88,75,72,60 not 118,8,75,72,60
    // Rule: prefer 2-digit grouping unless first char is '3' or higher AND
    //       taking 3 digits makes more sense (e.g. 300, 270, 239, 209, 178, 149).
    //
    // Heuristic: take 3 digits only if the 3-digit value is >= 100 AND
    //            the remaining string would start with a digit < 3 (i.e. the
    //            next group would be small), OR if there's exactly one char left.
    // This correctly handles "300270239209178149" → 300,270,239,209,178,149
    // and "1188757260" → 11,88,75,72,60 (first digit is 1 → try 2 first).

    const remaining = s.slice(i);
    if (/^\d/.test(remaining)) {
      // Is this a 3-digit DPD (100-365)?
      const three = remaining.match(/^(\d{3})/);
      const two   = remaining.match(/^(\d{2})/);
      const one   = remaining.match(/^(\d{1})/);

      if (three) {
        const v3 = parseInt(three[1], 10);
        const lastToken = tokens.length > 0 ? parseInt(tokens[tokens.length - 1], 10) : NaN;

        // Accept 3-digit if:
        //   1. value is in valid DPD range (100-365)
        //   2. AND it's not clearly a misparse (i.e. the previous token was
        //      also large, OR the previous token was 0 / NaN)
        //   Reject when: previous valid token < 100 AND v3 > previous (ascending
        //   is impossible in a defaulting sequence, indicating a misparse like
        //   "26" + "0" getting parsed as "260").
        const prevIsSmall = !isNaN(lastToken) && lastToken < 100;
        const isLargerThanPrev = !isNaN(lastToken) && v3 > lastToken;
        const looksMisparsed = prevIsSmall && isLargerThanPrev;

        if (v3 >= 100 && v3 <= 365 && !looksMisparsed) {
          tokens.push(normaliseDpdValue(three[1])); i += 3; continue;
        }
        // v3 < 100, > 365, or looks misparsed — fall through to 2-digit
      }
      if (two)  { tokens.push(normaliseDpdValue(two[1]));  i += 2; continue; }
      if (one)  { tokens.push(normaliseDpdValue(one[1]));  i += 1; continue; }
    }

    i++; // unknown char
  }
  return tokens;
}


function computeMaxDpd(tokens) {
  let max = 0;
  for (const t of tokens) {
    if (['SUB','DBT','LSS'].includes(t.toUpperCase())) { max = Math.max(max, 90); continue; }
    const n = parseInt(t, 10);
    if (!isNaN(n)) max = Math.max(max, n);
  }
  return max;
}

// ── parseAccounts ──────────────────────────────────────────────────────────
const ACCOUNT_HEADER_RE = /^\(MEMBER\s+NAME\)\(ACCOUNT\s+TYPE\)\(ACCOUNT\s+NUMBER\)\(OWNERSHIP\)$/;

function parseAccounts(lines) {
  const accounts = [], warnings = [];

  const accountStarts = [];
  for (let i = 0; i < lines.length; i++) {
    if (ACCOUNT_HEADER_RE.test(lines[i].trim())) accountStarts.push(i - 1);
  }

  const enqStart  = lines.findIndex(l => l.trim() === 'ENQUIRY INFORMATION');
  const accountEnd = enqStart >= 0 ? enqStart : lines.length;

  for (let ai = 0; ai < accountStarts.length; ai++) {
    const start = accountStarts[ai];
    const end   = ai + 1 < accountStarts.length ? accountStarts[ai + 1] : accountEnd;
    const block = lines.slice(start, end);
    try {
      const acct = parseAccountBlock(block, warnings);
      if (acct) accounts.push(acct);
    } catch (e) {
      warnings.push(`Account at line ${start + 1}: ${e.message}`);
    }
  }

  return { accounts, warnings };
}

// ── parseEnquiries ─────────────────────────────────────────────────────────
// Structure observed in Ankur PDF:
//   "ENQUIRY INFORMATION"
//   MONTH/YEAR artifacts
//   "MEMBER NAMEDATE OF ENQUIRY"
//   <95 member+date rows>     ← block 1
//   "ENQUIRY PURPOSE"
//   <95 purposes>             ← purposes for block 1
//   <80 member+date rows>     ← block 2 (continues straight after purposes)
//   <161 more purposes>       ← but these are actually block-2 member+dates
//                               disguised as purposes followed by block-2 purposes
//
// Simpler model that actually matches: collect ALL lines after
// "MEMBER NAMEDATE OF ENQUIRY" until "END OF CREDIT". Classify each line:
//   • ends with YYYY-MM-DD → member+date entry
//   • next line after member (no date) → purpose
//   • else if it's ENQUIRY PURPOSE header → skip
//   • else it's a purpose for the previous member+date
//
// Actually the clearest model: two passes.
//   Pass 1: collect all member+date entries (all lines ending with YYYY-MM-DD)
//   Pass 2: collect all purpose lines (lines between ENQUIRY PURPOSE header
//           and the next date-ending line or END)
//
// Given the actual structure we saw:
//   lines 1434-1528: 95 member+date lines
//   line 1529: ENQUIRY PURPOSE
//   lines 1530-1624: 95 purpose lines
//   line 1625: blank
//   lines 1626-1706: 81 member+date lines (second block)
//   lines 1707-1786: 161 purpose lines (second block purposes + noise)
//
// Strategy: scan once. Put every date-terminated line into memberDates[].
// Put every non-header, non-blank line that appears AFTER "ENQUIRY PURPOSE"
// and BEFORE the next date-terminated line (or END) into purposes[].
function parseEnquiries(lines) {
  const enqStart = lines.findIndex(l => l.trim() === 'ENQUIRY INFORMATION');
  if (enqStart < 0) return { enquiries: [], warnings: ['No ENQUIRY INFORMATION section found'] };

  const warnings = [];
  const enqLines = lines.slice(enqStart + 1);

  const DATE_RE = /(\d{4}-\d{2}-\d{2})$/;

  const memberDates = []; // { member, date }
  const purposes    = []; // string

  let state = 'SKIP'; // SKIP → MEMBER → PURPOSE → MEMBER → PURPOSE …
  let i     = 0;

  while (i < enqLines.length) {
    const l = enqLines[i].trim();
    i++;

    if (!l || /^(MONTH|YEAR)$/.test(l)) continue;
    if (/^END\s+OF\s+CREDIT/i.test(l))  break;
    if (/^Disclaimer:/i.test(l))         break;

    if (/^MEMBER\s+NAME/i.test(l)) { state = 'MEMBER'; continue; }
    if (/^ENQUIRY\s+PURPOSE$/i.test(l)) { state = 'PURPOSE'; continue; }

    if (state === 'SKIP') continue;

    if (state === 'MEMBER') {
      const dateMatch = l.match(DATE_RE);
      if (dateMatch) {
        const dateStr  = dateMatch[1];
        const member   = l.slice(0, l.lastIndexOf(dateStr)).trim();
        const [y, m, d] = dateStr.split('-');
        memberDates.push({ member: member || l, date: `${d}/${m}/${y}` });
        continue;
      }
      // No date on this line — check if next line is a bare date
      if (i < enqLines.length && /^\d{4}-\d{2}-\d{2}$/.test(enqLines[i].trim())) {
        const [y, m, d] = enqLines[i].trim().split('-');
        memberDates.push({ member: l, date: `${d}/${m}/${y}` });
        i++;
        continue;
      }
      // Some other line in MEMBER section — could be a stray purpose label; skip
      continue;
    }

    if (state === 'PURPOSE') {
      // If this line ends with a date, it's a member-date from the second block
      const dateMatch = l.match(DATE_RE);
      if (dateMatch) {
        // Switch back to collecting member-dates
        state = 'MEMBER';
        const dateStr   = dateMatch[1];
        const member    = l.slice(0, l.lastIndexOf(dateStr)).trim();
        const [y, m, d] = dateStr.split('-');
        memberDates.push({ member: member || l, date: `${d}/${m}/${y}` });
        continue;
      }
      purposes.push(l);
    }
  }

  if (memberDates.length !== purposes.length) {
    warnings.push(
      `Enquiry count mismatch: ${memberDates.length} member-date pairs vs ` +
      `${purposes.length} purposes. Pairing by position; extras get null purpose.`
    );
  }

  const enquiries = memberDates.map((p, idx) => ({
    member:  p.member,
    date:    p.date,
    purpose: purposes[idx] || null,
    amount:  null,
  }));

  return { enquiries, warnings };
}

// ── parseCibilPdfText — main entry point ───────────────────────────────────
function parseCibilPdfText(rawText) {
  const lines    = splitLines(rawText);
  const warnings = [];

  const isValidCibil =
    lines.some(l => l.includes('CIBIL SCORE') ||
                    l.includes('ACCOUNT INFORMATION') ||
                    l.includes('CONTROL NUMBER:'));

  if (!isValidCibil) {
    return {
      header: {}, accounts: [], enquiries: [],
      parseWarnings: ['Not a CIBIL report — skipping deterministic parse'],
      isValidCibil: false,
    };
  }

  const header = extractHeaderFields(lines);
  const { accounts, warnings: aw } = parseAccounts(lines);
  const { enquiries, warnings: ew } = parseEnquiries(lines);

  warnings.push(...aw, ...ew);
  return { header, accounts, enquiries, parseWarnings: warnings, isValidCibil: true };
}

// ── buildCompactContext ────────────────────────────────────────────────────
// Compact summary for qualitative LLM call (Part B). Does NOT include
// all 60 accounts with full DPD history — only aggregates + problem accounts.
function buildCompactContext(header, accounts, enquiries) {
  const reportDate = header.report_date;
  const now  = reportDate ? parseDMY(reportDate) : new Date();
  const c6m  = new Date(now); c6m.setMonth(c6m.getMonth() - 6);
  const c12m = new Date(now); c12m.setMonth(c12m.getMonth() - 12);

  const enq6m  = enquiries.filter(e => parseDMY(e.date) >= c6m).length;
  const enq12m = enquiries.filter(e => parseDMY(e.date) >= c12m).length;

  const active   = accounts.filter(a => (a.status||'').toLowerCase() === 'active');
  const totalOut = accounts.reduce((s,a) => s + (a.current_balance    || 0), 0);
  const totalOvd = accounts.reduce((s,a) => s + (a.overdue_amount     || 0), 0);
  const totalSan = accounts.reduce((s,a) => s + (a.sanctioned_amount  || 0), 0);
  const totalWO  = accounts.reduce((s,a) => s + (a.written_off_amount || 0), 0);
  const maxDpd   = accounts.reduce((m,a) => Math.max(m, a.max_dpd || 0), 0);

  const problemAccounts = accounts
    .filter(a => (a.overdue_amount||0) > 0 || (a.max_dpd||0) > 30 || (a.written_off_amount||0) > 0)
    .slice(0, 20)
    .map(a => ({
      lender: a.lender, account_type: a.account_type,
      masked_account_number: a.masked_account_number,
      status: a.status, current_balance: a.current_balance,
      overdue_amount: a.overdue_amount,
      written_off_amount: a.written_off_amount, max_dpd: a.max_dpd,
    }));

  const typeMix = {};
  for (const a of accounts) { const k = a.account_type || 'Unknown'; typeMix[k] = (typeMix[k]||0) + 1; }

  return {
    client_name: header.client_name, credit_score: header.credit_score,
    score_band: header.score_band,   report_date: reportDate,
    total_accounts: accounts.length, active_accounts: active.length,
    closed_accounts: accounts.length - active.length,
    total_outstanding: totalOut, total_overdue: totalOvd,
    total_sanctioned: totalSan, total_written_off: totalWO,
    max_dpd_any: maxDpd, enquiries_6m: enq6m, enquiries_12m: enq12m,
    type_mix: typeMix, problem_accounts: problemAccounts,
  };
}

function parseDMY(dmy) {
  if (!dmy) return new Date(0);
  const [d, m, y] = dmy.split('/');
  return new Date(`${y}-${m}-${d}`);
}

module.exports = {
  parseCibilPdfText,
  buildCompactContext,
  _tokeniseDpdRun:  tokeniseDpdRun,
  _parseDpdHistory: parseDpdHistory,
};
