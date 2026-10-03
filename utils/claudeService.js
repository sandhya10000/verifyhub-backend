const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const Anthropic = require('@anthropic-ai/sdk');
const { PDFDocument } = require('pdf-lib');
const AIAnalysis = require('../models/AIAnalysis');
const CreditReport = require('../models/creditReport');
const { logStep } = require('./logger');
const { renderCreditReport } = require('./reportRenderer');
const pdfParse = require('pdf-parse');
const { parseCibilPdfText, buildCompactContext } = require('../services/cibilParser');

// Wallet debit helper — guarded + idempotent, never throws, so background
// analysis delivery can never break because of a ledger problem.
const debitAiPull = async (userId, analysisId) => {
  try {
    const { chargeForReport } = require('./wallet');
    const charge = await chargeForReport(userId, analysisId, 'ai', 'AI');
    if (!charge.ok) {
      console.warn(`[wallet] AI charge skipped (${charge.reason}) for analysis ${analysisId}`);
    } else {
      console.log(`[wallet] charged ₹${charge.total} for AI analysis ${analysisId} (balance ₹${charge.balance})`);
    }
  } catch (err) {
    console.error(`[wallet] AI charge error for analysis ${analysisId}:`, err.message);
  }
};


// ---------------------------------------------------------------------------
// Validate critical env vars at startup so problems are visible immediately
// ---------------------------------------------------------------------------
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL;

if (!CLAUDE_API_KEY) {
  console.error('[claudeService] ⚠️  CLAUDE_API_KEY is NOT set in environment variables!');
} else {
  // Show prefix/suffix to verify it matches the Console key without exposing the full secret
  const keyPreview = `${CLAUDE_API_KEY.slice(0, 14)}...${CLAUDE_API_KEY.slice(-6)}`;
  console.log(`[claudeService] API key loaded: ${keyPreview}`);
}

if (!CLAUDE_MODEL) {
  console.error('[claudeService] ⚠️  CLAUDE_MODEL is NOT set in environment variables!');
} else {
  console.log('[claudeService] Model configured:', CLAUDE_MODEL);
}

// ---------------------------------------------------------------------------
// Anthropic client — PDF beta header passed via defaultHeaders
// ---------------------------------------------------------------------------
const anthropic = new Anthropic({
  apiKey: CLAUDE_API_KEY,
  defaultHeaders: {
    'anthropic-beta': 'pdfs-2024-09-25',
  },
});

console.log('[claudeService] Anthropic client initialised.');

// ---------------------------------------------------------------------------
// Language map and instruction builder
// ---------------------------------------------------------------------------
const LANGUAGE_NAMES = {
  en: 'English', hi: 'Hindi',  ta: 'Tamil',   te: 'Telugu',
  kn: 'Kannada', mr: 'Marathi', bn: 'Bengali', gu: 'Gujarati',
  pa: 'Punjabi', ml: 'Malayalam', or: 'Odia',  as: 'Assamese',
  ur: 'Urdu',
};

/**
 * Builds the language instruction appended to the Claude system/user prompt
 * for the qualitative synthesis and single-call extraction.
 * Returns an empty string for English (no extra instruction needed).
 */
function buildLanguageInstruction(code) {
  const name = LANGUAGE_NAMES[code] || 'English';
  if (!code || code === 'en') return '';
  return (
    `\n\nOUTPUT LANGUAGE: Write ALL human-readable text in ${name} (${code}), ` +
    'using natural, simple wording a lending customer can understand. This includes ' +
    'executive_summary, recommendation, risk_factors[].title and explanation, ' +
    'action_month_1/2/3, whats_helping, whats_hurting, and ui_labels. ' +
    'Do NOT translate or change: JSON keys, enum values, numbers, currency amounts, ' +
    'dates, account numbers, lender/bank names, credit score bands used as enum values, ' +
    'or bureau names. Use standard Latin digits (0-9) for all numbers. ' +
    'Return valid JSON only, matching the tool schema exactly.'
  );
}

// ---------------------------------------------------------------------------
// Helper — detect Anthropic's PDF page-count limit error
// Matches: 400 invalid_request_error where the body or message mentions the
// 100-page PDF cap.  Intentionally narrow so other 400s still get the generic
// message.
// ---------------------------------------------------------------------------
function isPdfPageLimitError(err) {
  const message  = (err.message  || '').toLowerCase();
  const apiBody  = err.error ? JSON.stringify(err.error).toLowerCase() : '';

  const PAGE_LIMIT_PHRASE = 'maximum of 100 pdf pages';
  const PDF_SOURCE_PHRASE = 'pdf.source';

  return (
    err.status === 400 &&
    (
      message.includes(PAGE_LIMIT_PHRASE) ||
      apiBody.includes(PAGE_LIMIT_PHRASE) ||
      (message.includes(PDF_SOURCE_PHRASE) && err.status === 400) ||
      (apiBody.includes(PDF_SOURCE_PHRASE) && apiBody.includes('invalid_request_error'))
    )
  );
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const EXTRACTION_PROMPT = fs.readFileSync(
  path.join(__dirname, '../config/ai-extraction-prompt.txt'),
  'utf-8'
);
console.log('[claudeService] Extraction prompt loaded, length:', EXTRACTION_PROMPT.length, 'chars');

const CHUNK_EXTRACTION_PROMPT = fs.readFileSync(
  path.join(__dirname, '../config/chunk-extraction-prompt.txt'),
  'utf-8'
);
console.log('[claudeService] Chunk extraction prompt loaded, length:', CHUNK_EXTRACTION_PROMPT.length, 'chars');

// ---------------------------------------------------------------------------
// ANALYSIS_TOOL — expanded schema: all accounts, DPD history, enquiries,
// and qualitative fields (risk factors, action plan, projections).
// Claude returns this via tool_choice so output is always structured JSON.
// ---------------------------------------------------------------------------
const ANALYSIS_TOOL = {
  name: 'submit_credit_analysis',
  description: 'Submit the complete structured credit data extracted from the uploaded bureau report.',
  input_schema: {
    type: 'object',
    required: [
      'client_name', 'credit_score', 'accounts', 'enquiries',
      'executive_summary', 'risk_factors', 'action_month_1', 'action_month_2', 'action_month_3',
      'risk_concentration_paragraph', 'projection_assumptions', 'projected_scores',
      'recommendation', 'whats_helping', 'whats_hurting', 'top_priority',
    ],
    properties: {
      // Personal / Summary
      executive_summary: { type: 'string' },
      client_name:       { type: 'string' },
      report_date:       { type: 'string' },
      pan:               { type: ['string', 'null'] },
      dob:               { type: ['string', 'null'] },
      bureau_control_no: { type: ['string', 'null'] },
      credit_score:      { type: 'number' },
      score_band:        { type: 'string' },
      foir_percent:      { type: ['number', 'null'] },
      foir_rating:       { type: ['string', 'null'] },
      max_eligible_amount: { type: ['number', 'null'] },
      recommendation:    { type: 'string' },
      // Accounts
      accounts: {
        type: 'array',
        items: {
          type: 'object',
          required: ['lender', 'masked_account_number', 'account_type'],
          properties: {
            lender:                { type: 'string' },
            masked_account_number: { type: 'string' },
            account_type:          { type: 'string' },
            ownership:             { type: ['string', 'null'] },
            opened_date:           { type: ['string', 'null'] },
            closed_date:           { type: ['string', 'null'] },
            status:                { type: ['string', 'null'] },
            sanctioned_amount:     { type: ['number', 'null'] },
            current_balance:       { type: ['number', 'null'] },
            overdue_amount:        { type: 'number' },
            emi_amount:            { type: ['number', 'null'] },
            written_off_amount:    { type: 'number' },
            principal_written_off: { type: ['number', 'null'] },
            suit_filed:            { type: 'boolean' },
            max_dpd:               { type: 'number' },
            dpd_history: {
              type: 'array',
              items: {
                type: 'object',
                required: ['month', 'value'],
                properties: {
                  month: { type: 'string' },
                  value: { type: 'string' },
                },
              },
            },
          },
        },
      },
      // Enquiries
      enquiries: {
        type: 'array',
        items: {
          type: 'object',
          required: ['member', 'date'],
          properties: {
            member:  { type: 'string' },
            date:    { type: 'string' },
            purpose: { type: ['string', 'null'] },
            amount:  { type: ['number', 'null'] },
          },
        },
      },
      // Qualitative / judgment fields
      risk_factors: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title', 'explanation'],
          properties: {
            title:       { type: 'string' },
            explanation: { type: 'string' },
          },
        },
      },
      whats_helping:                { type: 'string' },
      whats_hurting:                { type: 'string' },
      top_priority:                 { type: 'string' },
      action_month_1:               { type: 'string' },
      action_month_2:               { type: 'string' },
      action_month_3:               { type: 'string' },
      risk_concentration_paragraph: { type: 'string' },
      projection_assumptions:       { type: 'string' },
      projected_scores: {
        type: 'array',
        items: { type: 'number' },
      },
      ui_labels: {
        type: 'object',
        description: 'UI section/field labels translated into the target language',
        properties: {
          credit_score:   { type: 'string' },
          score_band:     { type: 'string' },
          active_loans:   { type: 'string' },
          overdue_dpd:    { type: 'string' },
          enquiries:      { type: 'string' },
          foir:           { type: 'string' },
          max_eligible:   { type: 'string' },
          risk_factors:   { type: 'string' },
          recommendation: { type: 'string' },
          next_3_months:  { type: 'string' },
          whats_helping:  { type: 'string' },
          whats_hurting:  { type: 'string' },
          disclaimer:     { type: 'string' },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// QUALITATIVE_TOOL — used in synthesizeFinalResult() for the chunked path.
// Only asks Claude for the qualitative fields — account data already in DB.
// ---------------------------------------------------------------------------
const QUALITATIVE_TOOL = {
  name: 'submit_qualitative_analysis',
  description: 'Submit the qualitative analysis fields derived from the structured credit data.',
  input_schema: {
    type: 'object',
    required: ['executive_summary', 'risk_factors', 'action_month_1', 'action_month_2', 'action_month_3',
               'risk_concentration_paragraph', 'projection_assumptions', 'projected_scores',
               'recommendation', 'whats_helping', 'whats_hurting', 'top_priority'],
    properties: {
      executive_summary:            { type: 'string' },
      foir_percent:                 { type: ['number', 'null'] },
      foir_rating:                  { type: ['string', 'null'] },
      max_eligible_amount:          { type: ['number', 'null'] },
      recommendation:               { type: 'string' },
      risk_factors: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title', 'explanation'],
          properties: {
            title:       { type: 'string' },
            explanation: { type: 'string' },
          },
        },
      },
      whats_helping:                { type: 'string' },
      whats_hurting:                { type: 'string' },
      top_priority:                 { type: 'string' },
      action_month_1:               { type: 'string' },
      action_month_2:               { type: 'string' },
      action_month_3:               { type: 'string' },
      risk_concentration_paragraph: { type: 'string' },
      projection_assumptions:       { type: 'string' },
      projected_scores: {
        type: 'array',
        items: { type: 'number' },
      },
      ui_labels: {
        type: 'object',
        description: 'UI section/field labels translated into the target language',
        properties: {
          credit_score:   { type: 'string' },
          score_band:     { type: 'string' },
          active_loans:   { type: 'string' },
          overdue_dpd:    { type: 'string' },
          enquiries:      { type: 'string' },
          foir:           { type: 'string' },
          max_eligible:   { type: 'string' },
          risk_factors:   { type: 'string' },
          recommendation: { type: 'string' },
          next_3_months:  { type: 'string' },
          whats_helping:  { type: 'string' },
          whats_hurting:  { type: 'string' },
          disclaimer:     { type: 'string' },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Tool definition -- per-chunk raw extraction (new for chunked pipeline)
// Used only when the PDF has more than CHUNK_PAGE_LIMIT pages.
// ---------------------------------------------------------------------------
const CHUNK_EXTRACTION_TOOL = {
  name: 'submit_chunk_extraction',
  description: 'Extract all credit account data found in this chunk of the credit report PDF.',
  input_schema: {
    type: 'object',
    properties: {
      summary_section_found: { type: 'boolean' },
      client_name:           { type: 'string' },
      report_date:           { type: 'string' },
      pan:                   { type: 'string' },
      dob:                   { type: 'string' },
      bureau_control_no:     { type: 'string' },
      credit_score:          { type: 'number' },
      score_band:            { type: 'string' },
      accounts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            masked_account_number: { type: 'string' },
            lender:                { type: 'string' },
            account_type:          { type: 'string' },
            ownership:             { type: 'string' },
            opened_date:           { type: 'string' },
            closed_date:           { type: 'string' },
            status:                { type: 'string' },
            sanctioned_amount:     { type: 'number' },
            current_balance:       { type: 'number' },
            overdue_amount:        { type: 'number' },
            written_off_amount:    { type: 'number' },
            max_dpd:               { type: 'number' },
            payment_history:       { type: 'array', items: { type: 'string' } },
          },
          required: ['masked_account_number', 'lender', 'account_type'],
        },
      },
    },
    required: ['summary_section_found', 'accounts'],
  },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CHUNK_PAGE_LIMIT = 100;  // Anthropic's hard cap per PDF document
const CHUNK_OVERLAP    = 3;    // pages repeated at start of each next chunk

// ---------------------------------------------------------------------------
// splitPdfIntoChunks
// Splits a full PDF buffer into overlapping 100-page chunks using pdf-lib.
// Returns Array<{ base64, startPage, endPage, pageCount }> (1-indexed pages).
// ---------------------------------------------------------------------------
async function splitPdfIntoChunks(fileBuffer) {
  const srcDoc     = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const totalPages = srcDoc.getPageCount();
  const chunks     = [];
  let startIdx     = 0; // 0-indexed

  while (startIdx < totalPages) {
    const endIdx = Math.min(startIdx + CHUNK_PAGE_LIMIT - 1, totalPages - 1);

    const chunkDoc = await PDFDocument.create();
    const indices  = [];
    for (let i = startIdx; i <= endIdx; i++) indices.push(i);

    const copiedPages = await chunkDoc.copyPages(srcDoc, indices);
    copiedPages.forEach((p) => chunkDoc.addPage(p));

    const chunkBytes = await chunkDoc.save();
    const base64     = Buffer.from(chunkBytes).toString('base64');

    chunks.push({
      base64,
      startPage: startIdx + 1,
      endPage:   endIdx   + 1,
      pageCount: endIdx - startIdx + 1,
    });

    const advance = CHUNK_PAGE_LIMIT - CHUNK_OVERLAP;
    startIdx += advance;

    // If remaining pages all fit within the overlap window, they are already
    // included in the last chunk -- stop to avoid a tiny duplicate chunk.
    if (startIdx < totalPages && totalPages - startIdx <= CHUNK_OVERLAP) break;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// precountPdfEntries
// Uses pdf-parse to extract raw text and count account blocks and enquiry rows
// in a CIBIL/Experian/Equifax PDF.  Wrapped in try/catch — returns null on any
// failure (scanned PDF, encrypted, etc.) so callers can skip the cross-check.
//
// CIBIL account block heuristics:
//   • Each account starts with a "Member Name" row (captures the lender name
//     on its own line, or the CIBIL two-column layout where the account type
//     and account number follow on the same line).
//   • We count lines that look like account headers:
//     – A line that contains one of several sentinel phrases printed at the
//       start of every CIBIL account block.
// Enquiry heuristic:
//   • CIBIL enquiry sections have lines of the form  DD/MM/YYYY  (a date).
//     We count distinct date-looking tokens that appear inside the enquiry
//     section (after "ENQUIRY INFORMATION" or "ENQUIRIES").
//
// Returns: { accountCount: number, enquiryCount: number } | null
// ---------------------------------------------------------------------------
async function precountPdfEntries(fileBuffer) {
  try {
    // Use the deterministic parser for CIBIL — far more accurate than the heuristic.
    const parsed = await pdfParse(fileBuffer);
    const text   = parsed.text || '';

    const parserResult = parseCibilPdfText(text);
    if (parserResult.isValidCibil && parserResult.accounts.length > 0) {
      const accountCount = parserResult.accounts.length;
      const enquiryCount = parserResult.enquiries.length;
      console.log(`[precountPdfEntries] CIBIL parser: ${accountCount} accounts, ${enquiryCount} enquiries`);
      return { accountCount, enquiryCount, _parsedText: text };
    }

    // Fallback heuristic for non-CIBIL formats
    const lines = text.split(/\r?\n/);
    const ACCOUNT_SENTINELS = ['MEMBER NAME','Member Name','ACCOUNT NUMBER','Account Number'];
    let accountCount = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (ACCOUNT_SENTINELS.some((s) => trimmed.includes(s))) accountCount++;
    }
    if (accountCount > 0) {
      const hasBoth =
        lines.some((l) => l.includes('MEMBER NAME') || l.includes('Member Name')) &&
        lines.some((l) => l.includes('ACCOUNT NUMBER') || l.includes('Account Number'));
      if (hasBoth) accountCount = Math.ceil(accountCount / 2);
    }
    const DATE_RE = /\b(\d{2}[\/\-]\d{2}[\/\-]\d{4}|\d{4}[\/\-]\d{2}[\/\-]\d{2})\b/g;
    let enquiryCount = 0;
    let inEnquiry = false;
    for (const line of lines) {
      if (!inEnquiry && /ENQUIRY INFORMATION|ENQUIRIES/i.test(line)) { inEnquiry = true; continue; }
      if (inEnquiry) { const m = line.match(DATE_RE); if (m) enquiryCount += m.length; }
    }
    console.log(`[precountPdfEntries] heuristic: ${accountCount} accounts, ${enquiryCount} enquiries`);
    return { accountCount, enquiryCount, _parsedText: text };
  } catch (err) {
    console.warn(`[precountPdfEntries] Could not extract text (${err.message}) — skipping cross-check`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// assertExtractionSanity
// Throws a human-readable error when the extracted counts are suspiciously
// low compared to the pdf-parse pre-count.  Never throws when precount is null
// (extraction failed gracefully) or when both sides say zero.
// threshold: fraction — 0 means ANY non-zero precount with zero extracted fails.
// ---------------------------------------------------------------------------
function assertExtractionSanity(label, extracted, precount, threshold = 0.50) {
  if (precount === null) return; // can't cross-check — skip
  if (precount.accountCount === 0 && precount.enquiryCount === 0) return; // thin file, valid

  const acctOk =
    precount.accountCount === 0 ||
    (extracted.accounts  >= precount.accountCount  * threshold);
  const enqOk  =
    precount.enquiryCount === 0 ||
    (extracted.enquiries >= precount.enquiryCount * threshold);

  if (!acctOk || !enqOk) {
    const msg =
      `[${label}] Extraction sanity check FAILED: ` +
      `extracted ${extracted.accounts} accounts (precount ${precount.accountCount}), ` +
      `${extracted.enquiries} enquiries (precount ${precount.enquiryCount}). ` +
      'Response likely truncated due to max_tokens. Marking as failed.';
    console.error(msg);
    const err = new Error('Extraction output too sparse — response likely truncated by token limit');
    err.isSanityFailure = true;
    throw err;
  }

  console.log(
    `[${label}] Sanity OK: ${extracted.accounts}/${precount.accountCount} accounts, ` +
    `${extracted.enquiries}/${precount.enquiryCount} enquiries`
  );
}

// ---------------------------------------------------------------------------
// extractChunkData
// One Claude call for one chunk. Retries once on failure, then throws with
// a page-range-specific error that is surfaced to the user.
// ---------------------------------------------------------------------------
async function extractChunkData(chunk, chunkIndex, totalChunks, analysisId) {
  const label = `[chunk ${chunkIndex + 1}/${totalChunks} pages ${chunk.startPage}-${chunk.endPage}]`;
  console.log(`[claudeService:${analysisId}] ${label} Starting extraction`);

  const CHUNK_MAX_TOKENS = 8000;

  async function attempt() {
    const response = await anthropic.messages.create({
      model:      CLAUDE_MODEL,
      max_tokens: CHUNK_MAX_TOKENS,
      system:     CHUNK_EXTRACTION_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type:   'document',
              source: { type: 'base64', media_type: 'application/pdf', data: chunk.base64 },
            },
            {
              type: 'text',
              text: `Extract all credit data from these ${chunk.pageCount} pages (pages ${chunk.startPage}-${chunk.endPage} of the full report). Return via the submit_chunk_extraction tool.`,
            },
          ],
        },
      ],
      tools:       [CHUNK_EXTRACTION_TOOL],
      tool_choice: { type: 'tool', name: 'submit_chunk_extraction' },
    });

    console.log(`[claudeService] ${label} stop_reason=${response.stop_reason} output_tokens=${response.usage?.output_tokens}`);

    // Fail loudly on truncation
    if (response.stop_reason === 'max_tokens') {
      const err = new Error(
        `${label} Model output truncated (max_tokens hit, output_tokens=${response.usage?.output_tokens}/${CHUNK_MAX_TOKENS})`
      );
      err.isTruncation = true;
      throw err;
    }

    const toolBlock = response.content.find((c) => c.type === 'tool_use');
    if (!toolBlock) {
      throw new Error(`${label} No tool_use block. stop_reason: ${response.stop_reason}`);
    }
    return toolBlock.input;
  }

  try {
    const result = await attempt();
    console.log(`[claudeService:${analysisId}] ${label} Extracted ${(result.accounts || []).length} accounts`);
    return result;
  } catch (firstErr) {
    console.warn(`[claudeService:${analysisId}] ${label} First attempt failed: ${firstErr.message} -- retrying in 3s`);
  }

  await new Promise((r) => setTimeout(r, 3000));
  try {
    const result = await attempt();
    console.log(`[claudeService:${analysisId}] ${label} Retry succeeded -- extracted ${(result.accounts || []).length} accounts`);
    return result;
  } catch (retryErr) {
    const wrapped = new Error(
      `Chunk extraction failed for pages ${chunk.startPage}-${chunk.endPage} after 1 retry: ${retryErr.message}`
    );
    wrapped.chunkIndex  = chunkIndex;
    wrapped.startPage   = chunk.startPage;
    wrapped.endPage     = chunk.endPage;
    wrapped.originalErr = retryErr;
    throw wrapped;
  }
}

// ---------------------------------------------------------------------------
// mergeChunkResults
// Combines all per-chunk extractions into one unified object.
// De-duplicates accounts by masked_account_number (case-insensitive).
// For duplicates (3-page overlap), keeps the entry with more payment history.
// Aggregates are computed from the final deduped list, never summed per-chunk.
// ---------------------------------------------------------------------------
function mergeChunkResults(chunkResults) {
  const merged = {
    client_name:       null,
    report_date:       null,
    pan:               null,
    dob:               null,
    bureau_control_no: null,
    credit_score:      null,
    score_band:        null,
    enquiries:         [],   // raw enquiry objects — counted deterministically in renderCreditReport
    accounts:          [],
  };

  const accountMap = new Map(); // normalized key -> index in merged.accounts

  for (const chunk of chunkResults) {
    // Personal/summary: take from first chunk that found the cover page
    if (chunk.summary_section_found && merged.credit_score === null) {
      merged.client_name       = chunk.client_name       || null;
      merged.report_date       = chunk.report_date       || null;
      merged.pan               = chunk.pan               || null;
      merged.dob               = chunk.dob               || null;
      merged.bureau_control_no = chunk.bureau_control_no || null;
      merged.credit_score      = chunk.credit_score      != null ? chunk.credit_score : null;
      merged.score_band        = chunk.score_band        || null;
    }

    if (chunk.enquiries && Array.isArray(chunk.enquiries) && chunk.enquiries.length > 0) {
      merged.enquiries = (merged.enquiries || []).concat(chunk.enquiries);
    }

    for (const acct of (chunk.accounts || [])) {
      const key = (acct.masked_account_number || '').trim().toLowerCase();

      if (!accountMap.has(key)) {
        accountMap.set(key, merged.accounts.length);
        merged.accounts.push(Object.assign({}, acct));
      } else {
        // Duplicate from overlap -- keep whichever has more payment history
        const idx         = accountMap.get(key);
        const existing    = merged.accounts[idx];
        const existingLen = (existing.payment_history || []).length;
        const incomingLen = (acct.payment_history     || []).length;
        if (incomingLen > existingLen) {
          merged.accounts[idx] = Object.assign({}, acct);
        }
      }
    }
  }

  // Aggregates from deduped list (never from per-chunk sums -- avoids double-counting)
  merged.total_accounts    = merged.accounts.length;
  merged.total_outstanding = merged.accounts.reduce((s, a) => s + (a.current_balance    || 0), 0);
  merged.total_overdue     = merged.accounts.reduce((s, a) => s + (a.overdue_amount     || 0), 0);
  merged.total_sanctioned  = merged.accounts.reduce((s, a) => s + (a.sanctioned_amount  || 0), 0);
  merged.total_written_off = merged.accounts.reduce((s, a) => s + (a.written_off_amount || 0), 0);
  merged.active_accounts   = merged.accounts.filter(
    (a) => (a.status || '').toLowerCase() === 'active'
  ).length;

  return merged;
}

// ---------------------------------------------------------------------------
// synthesizeFinalResult
// For the chunked path: after all chunks are merged, one Claude call
// produces the QUALITATIVE fields (risk factors, action plan, projections)
// from the merged JSON. No PDF re-sent. Uses QUALITATIVE_TOOL.
// language: ISO code for the output language (e.g. 'hi' for Hindi).
// Returns an object that is merged with mergedData before rendering.
// ---------------------------------------------------------------------------
async function synthesizeFinalResult(mergedData, analysisId, language = 'en') {
  console.log(`[claudeService:${analysisId}] Synthesizing qualitative fields from merged data (${mergedData.total_accounts} accounts)... language=${language}`);

  const context = {
    client_name:       mergedData.client_name,
    report_date:       mergedData.report_date,
    credit_score:      mergedData.credit_score,
    score_band:        mergedData.score_band,
    enquiries_6m:      null,
    enquiries_12m:     null,
    total_accounts:    mergedData.total_accounts,
    total_outstanding: mergedData.total_outstanding,
    total_overdue:     mergedData.total_overdue,
    total_sanctioned:  mergedData.total_sanctioned,
    total_written_off: mergedData.total_written_off,
    accounts: (mergedData.accounts || []).map((a) => ({
      lender:             a.lender,
      account_type:       a.account_type,
      status:             a.status,
      sanctioned_amount:  a.sanctioned_amount,
      current_balance:    a.current_balance,
      overdue_amount:     a.overdue_amount,
      written_off_amount: a.written_off_amount,
      max_dpd:            a.max_dpd,
      dpd_months:         (a.dpd_history || a.payment_history || []).length,
    })),
  };
  return runQualitativeAnalysis(context, analysisId, language);
}

// ---------------------------------------------------------------------------
// runQualitativeAnalysis
// Calls Claude with a COMPACT summary (no full account arrays or DPD history)
// and returns the qualitative fields via QUALITATIVE_TOOL.
// Used by both the deterministic parser path and the chunked merge path.
// ---------------------------------------------------------------------------
async function runQualitativeAnalysis(compactContext, analysisId, language = 'en') {
  const contextStr = JSON.stringify(compactContext, null, 2);
  console.log(`[claudeService:${analysisId}] runQualitativeAnalysis: context size=${contextStr.length} chars`);

  const qualitativePrompt =
    'You are a senior credit analyst. The following JSON contains structured credit portfolio data. ' +
    'Produce a thorough qualitative analysis using the submit_qualitative_analysis tool. ' +
    'Be specific — name the lenders and cite actual figures. ' +
    'Include concrete, actionable advice in the 90-day action plan.' +
    buildLanguageInstruction(language) +
    '\n\n```json\n' + contextStr + '\n```';

  const QUAL_MAX_TOKENS = 5000;
  const response = await anthropic.messages.create({
    model:      CLAUDE_MODEL,
    max_tokens: QUAL_MAX_TOKENS,
    messages: [
      { role: 'user', content: [{ type: 'text', text: qualitativePrompt }] },
    ],
    tools:       [QUALITATIVE_TOOL],
    tool_choice: { type: 'tool', name: 'submit_qualitative_analysis' },
  });

  console.log(`[claudeService:${analysisId}] runQualitativeAnalysis: stop_reason=${response.stop_reason} output_tokens=${response.usage?.output_tokens}`);

  if (response.stop_reason === 'max_tokens') {
    const err = new Error(
      `Qualitative analysis truncated (max_tokens=${QUAL_MAX_TOKENS}, output=${response.usage?.output_tokens})`
    );
    err.isTruncation = true;
    throw err;
  }

  const toolBlock = response.content.find((c) => c.type === 'tool_use');
  if (!toolBlock) {
    throw new Error(`runQualitativeAnalysis: no tool_use block (stop_reason=${response.stop_reason})`);
  }
  console.log(`[claudeService:${analysisId}] Qualitative analysis complete.`);
  return toolBlock.input;
}

// ---------------------------------------------------------------------------
// saveToCreditReport
// Automatically creates a record in the CreditReport collection so it appears
// in the Reports tab for the user, preventing duplicates via reportId.
// ---------------------------------------------------------------------------
async function saveToCreditReport(analysisId, userId, result) {
  try {
    const existing = await CreditReport.findOne({ reportId: analysisId.toString(), userId: userId });
    if (existing) {
      console.log(`[claudeService:${analysisId}] CreditReport already exists.`);
      return;
    }

    await CreditReport.create({
      userId: userId,
      reportId: analysisId.toString(),
      name: result.client_name || "Unknown Customer",
      mobile: "0000000000", // Default as mobile is not extracted
      pan: result.pan || "UNKNOWN",
      reportType: "AI Analysis",
      bureau: "CIBIL", // Assuming default or determined from data
      score: result.credit_score || null,
      status: "Success",
      isPublic: false,
      consent: "Y",
      reportData: result
    });
    console.log(`[claudeService:${analysisId}] Saved AI analysis to CreditReport successfully.`);
  } catch (err) {
    console.error(`[claudeService:${analysisId}] Error saving to CreditReport:`, err);
  }
}

// ---------------------------------------------------------------------------
// processAnalysisInBackground
// Routes to single-call path (<=100 pages) or chunked path (>100 pages).
// language: ISO code for the report output language (e.g. 'hi'). Default 'en'.
// ---------------------------------------------------------------------------
async function processAnalysisInBackground(analysisId, language = 'en') {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[claudeService:${analysisId}] Background job started at ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  const analysis = await AIAnalysis.findById(analysisId);
  if (!analysis) {
    console.error(`[claudeService:${analysisId}] Analysis record not found in DB -- aborting.`);
    return;
  }

  try {
    // ---- 1. Mark as processing ----
    await AIAnalysis.findByIdAndUpdate(analysisId, { status: 'processing' });
    console.log(`[claudeService:${analysisId}] Status -> processing`);

    // ---- 2. Read the uploaded file ----
    let fileBuffer;
    logStep(analysisId, 'File Parsing Start');
    try {
      fileBuffer = await fs.promises.readFile(analysis.filePath);
    } catch (fileErr) {
      console.error(`[claudeService:${analysisId}] Failed to read file at path: ${analysis.filePath}`);
      console.error(`[claudeService:${analysisId}] File read error:`, fileErr);
      throw fileErr;
    }

    const mediaType  = mime.lookup(analysis.filePath) || 'application/pdf';
    const fileSizeKB = (fileBuffer.length / 1024).toFixed(1);
    console.log(`[claudeService:${analysisId}] File ready | ${fileSizeKB} KB | ${mediaType}`);

    // ---- 3. Determine page count (PDFs only) ----
    let pageCount = null;
    if (mediaType === 'application/pdf') {
      try {
        const tmpDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
        pageCount = tmpDoc.getPageCount();
        console.log(`[claudeService:${analysisId}] PDF page count: ${pageCount}`);
      } catch (pdfErr) {
        console.warn(`[claudeService:${analysisId}] Could not count pages: ${pdfErr.message} -- defaulting to single-call path`);
      }
    }
    
    logStep(analysisId, 'File Parsing Complete', { mediaType, fileSizeKB, pageCount });

    // ---- 3b. PDF pre-count for sanity-check later (wrapped — never fatal) ----
    let precount = null;
    if (mediaType === 'application/pdf') {
      precount = await precountPdfEntries(fileBuffer);
      if (precount) {
        console.log(`[claudeService:${analysisId}] PDF pre-count: ${precount.accountCount} accounts, ${precount.enquiryCount} enquiries`);
      }
    }

    const useChunkedPath = pageCount !== null && pageCount > CHUNK_PAGE_LIMIT;

    // ==========================================================================
    // PATH P -- DETERMINISTIC PARSER PATH (CIBIL format, any size)
    // Uses the cibilParser module for extraction (no Claude call for accounts)
    // then calls Claude with a compact qualitative-only context.
    // Falls through to PATH A only if isValidCibil=false.
    // ==========================================================================
    const parsedText = precount?._parsedText;
    if (parsedText) {
      const parserResult = parseCibilPdfText(parsedText);
      if (parserResult.isValidCibil && parserResult.accounts.length > 0) {
        console.log(
          `[claudeService:${analysisId}] Path: DETERMINISTIC PARSER ` +
          `(${parserResult.accounts.length} accounts, ${parserResult.enquiries.length} enquiries, ` +
          `${parserResult.parseWarnings.length} warnings)`
        );
        if (parserResult.parseWarnings.length) {
          parserResult.parseWarnings.forEach(w =>
            console.warn(`[claudeService:${analysisId}]   Parser warning: ${w}`)
          );
        }

        // Sanity: parser count must match precount
        if (precount) {
          assertExtractionSanity(
            `claudeService:${analysisId}:PARSER`,
            { accounts: parserResult.accounts.length, enquiries: parserResult.enquiries.length },
            precount,
            0.85  // tighter threshold — parser should be near-exact
          );
        }

        // Build compact context for qualitative LLM call
        const compactCtx = buildCompactContext(
          parserResult.header,
          parserResult.accounts,
          parserResult.enquiries
        );

        console.log(`[claudeService:${analysisId}] Calling qualitative LLM with compact context (${JSON.stringify(compactCtx).length} chars)...`);
        logStep(analysisId, 'Qualitative Analysis Start (parser path)');
        const qualStart = Date.now();
        const qualFields = await runQualitativeAnalysis(compactCtx, analysisId, language);
        logStep(analysisId, 'Qualitative Analysis Complete (parser path)', { durationMs: Date.now() - qualStart });

        // Merge: parser data + qualitative fields + header
        const fullData = Object.assign(
          {},
          parserResult.header,
          {
            accounts:  parserResult.accounts,
            enquiries: parserResult.enquiries,
            language,
          },
          qualFields
        );

        // Compute aggregates that renderCreditReport expects
        const active   = parserResult.accounts.filter(a => (a.status||'').toLowerCase() === 'active');
        fullData.total_accounts    = parserResult.accounts.length;
        fullData.active_accounts   = active.length;
        fullData.total_outstanding = parserResult.accounts.reduce((s,a) => s + (a.current_balance   ||0), 0);
        fullData.total_overdue     = parserResult.accounts.reduce((s,a) => s + (a.overdue_amount    ||0), 0);
        fullData.total_sanctioned  = parserResult.accounts.reduce((s,a) => s + (a.sanctioned_amount ||0), 0);
        fullData.total_written_off = parserResult.accounts.reduce((s,a) => s + (a.written_off_amount||0), 0);

        // Render HTML — fatal on this path too
        logStep(analysisId, 'HTML Template Render Start (parser path)');
        const renderStart = Date.now();
        const htmlReport = await renderCreditReport(fullData);
        logStep(analysisId, 'HTML Template Render Complete (parser path)', { durationMs: Date.now() - renderStart, lengthChars: htmlReport.length });
        console.log(`[claudeService:${analysisId}] HTML rendered in ${Date.now() - renderStart}ms (${htmlReport.length} chars)`);

        // Persist
        const hasOverdueParsed = parserResult.accounts.some(a => (a.overdue_amount||0) > 0);
        await saveToCreditReport(analysisId, analysis.userId, fullData);
        await AIAnalysis.findByIdAndUpdate(analysisId, {
          status:    'completed',
          isChunked: false,
          mergedData: fullData,
          debugError: null,
          result: {
            score:             fullData.credit_score,
            scoreBand:         fullData.score_band,
            activeLoans:       active.length,
            overdueStatus:     hasOverdueParsed ? 'Overdue' : 'Clear',
            enquiries6m:       null,
            enquiriesRating:   null,
            foirPercent:       qualFields.foir_percent,
            foirRating:        qualFields.foir_rating,
            maxEligibleAmount: qualFields.max_eligible_amount,
            recommendation:    qualFields.recommendation,
          },
          htmlReport,
          htmlGenerating: false,
          htmlStatus:     'completed',
        });
        logStep(analysisId, 'Result Persistence Complete (parser path)', { htmlStored: true });
        console.log(`[claudeService:${analysisId}] Status -> completed (parser path)`);
        await debitAiPull(analysis.userId, analysisId);
        return;  // ← done — do NOT fall through to PATH A
      }

      console.log(
        `[claudeService:${analysisId}] Parser path skipped — ` +
        `isValidCibil=${parserResult.isValidCibil} accounts=${parserResult.accounts.length}. ` +
        'Falling through to PATH A (LLM extraction).'
      );
    } else {
      console.log(`[claudeService:${analysisId}] No parsedText available — skipping parser path, going to PATH A.`);
    }

    // ==========================================================================
    // PATH A -- SHORT FILE (<=100 pages) -- single Claude call, unchanged
    // ==========================================================================
    if (!useChunkedPath) {
      console.log(`[claudeService:${analysisId}] Path: SINGLE-CALL (${pageCount !== null ? pageCount : '?'} pages)`);

      const base64Data = fileBuffer.toString('base64');
      console.log(`[claudeService:${analysisId}]   path      : ${analysis.filePath}`);
      console.log(`[claudeService:${analysisId}]   mediaType : ${mediaType}`);
      console.log(`[claudeService:${analysisId}]   size      : ${fileSizeKB} KB`);
      console.log(`[claudeService:${analysisId}]   base64 len: ${base64Data.length} chars`);
      console.log(`[claudeService:${analysisId}] Calling Claude API...`);
      console.log(`[claudeService:${analysisId}]   model     : ${CLAUDE_MODEL}`);
      const PATH_A_MAX_TOKENS = 16000;
      console.log(`[claudeService:${analysisId}]   max_tokens: ${PATH_A_MAX_TOKENS}`);

      let response;
      try {
        logStep(analysisId, 'Analysis API Call Start', { model: CLAUDE_MODEL, language });
        response = await anthropic.messages.create({
          model:      CLAUDE_MODEL,
          max_tokens: PATH_A_MAX_TOKENS,
          system:     EXTRACTION_PROMPT + buildLanguageInstruction(language),
          messages: [
            {
              role: 'user',
              content: [
                {
                  type:   'document',
                  source: { type: 'base64', media_type: mediaType, data: base64Data },
                },
                { type: 'text', text: 'Extract all credit data from this report and return via the submit_credit_analysis tool.' },
              ],
            },
          ],
          tools:       [ANALYSIS_TOOL],
          tool_choice: { type: 'tool', name: 'submit_credit_analysis' },
        });
        logStep(analysisId, 'Analysis API Call Complete', { usage: response.usage });

      } catch (apiErr) {
        console.error(`[claudeService:${analysisId}] Claude API call FAILED`);
        console.error(`[claudeService:${analysisId}]   Error type    :`, apiErr.constructor && apiErr.constructor.name);
        console.error(`[claudeService:${analysisId}]   Error message :`, apiErr.message);
        if (apiErr.status !== undefined) console.error(`[claudeService:${analysisId}]   HTTP status   :`, apiErr.status);
        if (apiErr.error  !== undefined) console.error(`[claudeService:${analysisId}]   API error body:`, JSON.stringify(apiErr.error, null, 2));
        if (apiErr.headers) {
          const rl = {};
          for (const h of ['x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests', 'retry-after']) {
            if (apiErr.headers[h]) rl[h] = apiErr.headers[h];
          }
          if (Object.keys(rl).length) console.error(`[claudeService:${analysisId}]   Rate-limit hdrs:`, rl);
        }
        console.error(`[claudeService:${analysisId}]   Full error obj:`, apiErr);
        throw apiErr;
      }

      console.log(`[claudeService:${analysisId}] Claude response received`);
      console.log(`[claudeService:${analysisId}]   stop_reason   : ${response.stop_reason}`);
      console.log(`[claudeService:${analysisId}]   content blocks: ${response.content.length}`);
      console.log(`[claudeService:${analysisId}]   input_tokens  : ${response.usage?.input_tokens}`);
      console.log(`[claudeService:${analysisId}]   output_tokens : ${response.usage?.output_tokens}`);

      // ── FAIL LOUDLY: truncation guard ────────────────────────────────────
      if (response.stop_reason === 'max_tokens') {
        const truncErr = new Error(
          `Model output truncated (stop_reason=max_tokens, output_tokens=${response.usage?.output_tokens}/${PATH_A_MAX_TOKENS}). ` +
          'The report likely has too many accounts or enquiries for a single call. Failing loudly.'
        );
        truncErr.isTruncation = true;
        throw truncErr;
      }

      const toolUseBlock = response.content.find((c) => c.type === 'tool_use');
      if (!toolUseBlock) {
        console.error(`[claudeService:${analysisId}] No tool_use block found in response.`);
        console.error(`[claudeService:${analysisId}] Full response content:`, JSON.stringify(response.content, null, 2));
        throw new Error('Model did not return structured output via tool call');
      }

      const result = toolUseBlock.input;
      result.language = language; // ensure language is passed to EJS template

      const extractedAccounts  = (result.accounts  || []).length;
      const extractedEnquiries = (result.enquiries || []).length;
      console.log(`[claudeService:${analysisId}] PATH A extracted: ${extractedAccounts} accounts, ${extractedEnquiries} enquiries`);

      // ── Cross-check against pdf-parse pre-count ───────────────────────
      assertExtractionSanity(
        `claudeService:${analysisId}:PATH_A`,
        { accounts: extractedAccounts, enquiries: extractedEnquiries },
        precount
      );

      // ── Render HTML immediately from structured data (no second Claude call) ──
      logStep(analysisId, 'HTML Template Render Start');
      const renderStart = Date.now();
      // Render is fatal on PATH A — if it fails we must not store 'completed'
      const htmlReport = await renderCreditReport(result);
      logStep(analysisId, 'HTML Template Render Complete', { durationMs: Date.now() - renderStart, lengthChars: htmlReport.length });
      console.log(`[claudeService:${analysisId}] HTML rendered in ${Date.now() - renderStart}ms (${htmlReport.length} chars)`);

      // ── Single atomic DB write: result + HTML together ──
      logStep(analysisId, 'Result Persistence Start');
      const activeLoans = (result.accounts || []).filter(
        (a) => (a.status || '').toLowerCase() === 'active'
      ).length;
      const hasOverdue = (result.accounts || []).some((a) => (a.overdue_amount || 0) > 0);

      // Save to CreditReport collection
      await saveToCreditReport(analysisId, analysis.userId, result);

      await AIAnalysis.findByIdAndUpdate(analysisId, {
        status:           'completed',
        isChunked:        false,
        mergedData:       result,
        rawModelResponse: response,
        debugError:       null,
        // Keep backward-compat result fields for getAnalysis API response
        result: {
          score:             result.credit_score,
          scoreBand:         result.score_band,
          activeLoans,
          overdueStatus:     hasOverdue ? 'Overdue' : 'Clear',
          enquiries6m:       null,  // computed deterministically at render time
          enquiriesRating:   null,
          foirPercent:       result.foir_percent,
          foirRating:        result.foir_rating,
          maxEligibleAmount: result.max_eligible_amount,
          recommendation:    result.recommendation,
        },
        htmlReport:     htmlReport,
        htmlGenerating: false,
        htmlStatus:     htmlReport ? 'completed' : 'failed',
      });
      logStep(analysisId, 'Result Persistence Complete', { htmlStored: !!htmlReport });
      console.log(`[claudeService:${analysisId}] Status -> completed (single-call path, HTML stored inline)`);

      // Wallet debit (AI = ₹100 + GST) — post-success only
      await debitAiPull(analysis.userId, analysisId);

      return;
    }

    // ==========================================================================
    // PATH B -- LARGE FILE (>100 pages) -- chunked extraction pipeline
    // ==========================================================================
    console.log(`[claudeService:${analysisId}] Path: CHUNKED (${pageCount} pages, overlap=${CHUNK_OVERLAP})`);

    // B1. Split into overlapping 100-page chunks
    console.log(`[claudeService:${analysisId}] Splitting PDF into chunks...`);
    const chunks = await splitPdfIntoChunks(fileBuffer);
    console.log(`[claudeService:${analysisId}] Split into ${chunks.length} chunks:`);
    chunks.forEach((c, i) =>
      console.log(`[claudeService:${analysisId}]   Chunk ${i + 1}: pages ${c.startPage}-${c.endPage} (${c.pageCount} pages)`)
    );

    await AIAnalysis.findByIdAndUpdate(analysisId, {
      isChunked:       true,
      chunkCount:      chunks.length,
      chunksCompleted: 0,
    });

    // B2. Extract each chunk sequentially (not parallel -- avoids rate limits)
    const chunkResults = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkData = await extractChunkData(chunks[i], i, chunks.length, analysisId);
      chunkResults.push(chunkData);
      await AIAnalysis.findByIdAndUpdate(analysisId, { chunksCompleted: i + 1 });
      console.log(`[claudeService:${analysisId}] Progress: ${i + 1}/${chunks.length} chunks done`);
    }

    // B3. Merge all chunk results (de-dup by masked account number)
    console.log(`[claudeService:${analysisId}] Merging ${chunkResults.length} chunk results...`);
    const mergedData = mergeChunkResults(chunkResults);
    console.log(`[claudeService:${analysisId}] Merge complete: ${mergedData.total_accounts} deduped accounts, score=${mergedData.credit_score}`);

    // B4. Synthesis call — qualitative fields from merged JSON (no PDF re-send)
    const qualitativeFields = await synthesizeFinalResult(mergedData, analysisId, language);

    // B4b. Merge qualitative fields into mergedData for rendering
    const fullData = Object.assign({}, mergedData, qualitativeFields);
    fullData.language = language; // ensure language is passed to EJS template

    // B4c. Render HTML from merged structured data — fatal on chunked path too
    logStep(analysisId, 'HTML Template Render Start (chunked path)');
    const renderStart = Date.now();
    const htmlReport = await renderCreditReport(fullData);
    logStep(analysisId, 'HTML Template Render Complete (chunked path)', { durationMs: Date.now() - renderStart, lengthChars: htmlReport.length });
    console.log(`[claudeService:${analysisId}] HTML rendered in ${Date.now() - renderStart}ms (${htmlReport.length} chars)`);

    // B5. Persist completed result — single atomic write with HTML
    const activeLoansChunked = (mergedData.accounts || []).filter(
      (a) => (a.status || '').toLowerCase() === 'active'
    ).length;
    const hasOverdueChunked = (mergedData.accounts || []).some((a) => (a.overdue_amount || 0) > 0);

    // Save to CreditReport collection
    await saveToCreditReport(analysisId, analysis.userId, fullData);

    await AIAnalysis.findByIdAndUpdate(analysisId, {
      status:     'completed',
      isChunked:  true,
      mergedData: fullData,
      debugError: null,
      result: {
        score:             mergedData.credit_score || qualitativeFields.credit_score,
        scoreBand:         mergedData.score_band   || qualitativeFields.score_band,
        activeLoans:       activeLoansChunked,
        overdueStatus:     hasOverdueChunked ? 'Overdue' : 'Clear',
        enquiries6m:       null,  // computed deterministically at render time
        enquiriesRating:   null,
        foirPercent:       qualitativeFields.foir_percent,
        foirRating:        qualitativeFields.foir_rating,
        maxEligibleAmount: qualitativeFields.max_eligible_amount,
        recommendation:    qualitativeFields.recommendation,
      },
      htmlReport:     htmlReport,
      htmlGenerating: false,
      htmlStatus:     htmlReport ? 'completed' : 'failed',
    });
    console.log(`[claudeService:${analysisId}] Status -> completed (chunked path, HTML stored inline)`);

    // Wallet debit (AI = ₹100 + GST) — post-success only
    await debitAiPull(analysis.userId, analysisId);

  } catch (err) {
    console.error('!'.repeat(60));
    console.error(`[claudeService:${analysisId}] BACKGROUND JOB FAILED at ${new Date().toISOString()}`);
    console.error(`[claudeService:${analysisId}]   Error type    :`, (err.constructor && err.constructor.name) || typeof err);
    console.error(`[claudeService:${analysisId}]   Error message :`, err.message);
    if (err.status !== undefined) console.error(`[claudeService:${analysisId}]   HTTP status   :`, err.status);
    if (err.error  !== undefined) console.error(`[claudeService:${analysisId}]   API error body:`, JSON.stringify(err.error, null, 2));
    console.error(`[claudeService:${analysisId}]   Stack trace:\n`, err.stack);
    console.error('!'.repeat(60));

    const debugError = [
      `Type: ${(err.constructor && err.constructor.name) || typeof err}`,
      `Message: ${err.message}`,
      err.status ? `HTTP status: ${err.status}` : null,
      err.error  ? `API body: ${JSON.stringify(err.error)}` : null,
      `Stack: ${err.stack}`,
    ].filter(Boolean).join('\n');

    let userFacingMessage;
    if (err.isTruncation || err.isSanityFailure) {
      // The report has more data than can be processed in one call.
      // A clear, actionable message is shown to the user.
      userFacingMessage =
        "We couldn't fully analyse this report — it contains more accounts or enquiries " +
        'than can be processed in one pass. Please retry; if the problem persists, contact support.';
      console.error(`[claudeService:${analysisId}] -> Classified as truncation/sanity failure.`);
    } else if (isPdfPageLimitError(err)) {
      // Safety net -- chunked path should prevent this, but kept for edge cases.
      userFacingMessage =
        'This report has too many pages to analyze (limit: 100 pages per chunk). ' +
        'Please contact support.';
      console.error(`[claudeService:${analysisId}] -> Classified as PDF page-limit error.`);
    } else if (err.chunkIndex !== undefined) {
      // Chunk-specific failure -- name the exact page range
      userFacingMessage =
        `Analysis failed while processing pages ${err.startPage}-${err.endPage}. ` +
        'Please try again. If the problem persists, contact support.';
      console.error(`[claudeService:${analysisId}] -> Chunk failure (pages ${err.startPage}-${err.endPage}).`);
    } else {
      userFacingMessage = 'Analysis could not be completed. Please try again or contact support.';
    }

    await AIAnalysis.findByIdAndUpdate(analysisId, {
      status:       'failed',
      errorMessage: userFacingMessage,
      debugError,
    });

    // Flat ₹30 AI fail fee (any tier) — Claude was still called.
    // Skip for sanity/truncation failures where the model call itself may not
    // have produced valid output worth charging for.
    if (!err.isSanityFailure) {
      try {
        const { chargeFailedReport } = require('./wallet');
        const charge = await chargeFailedReport(analysis.userId, analysisId, 'ai', 'AI', true);
        if (charge.ok && !charge.free) {
          console.log(`[wallet] charged ₹${charge.total} AI fail fee for analysis ${analysisId}`);
        }
      } catch (walletErr) {
        console.error(`[wallet] AI fail-charge error for analysis ${analysisId}:`, walletErr.message);
      }
    } else {
      console.log(`[wallet] Skipping AI fail-charge for sanity/truncation failure (analysis ${analysisId}) — model output was unusable.`);
    }
  }
}

// ---------------------------------------------------------------------------
// generateFullHtmlReport — REMOVED.
// HTML is now rendered synchronously by reportRenderer.js immediately after
// the extraction tool call completes. No second Claude call is needed.
// This function is kept as a stub for any external callers that have not
// yet been updated, so the server does not crash at startup.
// ---------------------------------------------------------------------------
async function generateFullHtmlReport(analysisId) {
  console.warn(`[htmlReport:${analysisId}] generateFullHtmlReport() is deprecated. HTML is now generated inline during processAnalysisInBackground(). This call is a no-op.`);
  return null;
}

async function processHtmlGenerationInBackground(analysisId) {
  console.warn(`[processHtmlGenerationInBackground:${analysisId}] Deprecated — HTML is generated inline. No-op.`);
}

module.exports = { processAnalysisInBackground, generateFullHtmlReport, ANALYSIS_TOOL, processHtmlGenerationInBackground };


