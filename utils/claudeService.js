const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const Anthropic = require('@anthropic-ai/sdk');
const { PDFDocument } = require('pdf-lib');
const AIAnalysis = require('../models/AIAnalysis');

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
const CREDIT_ANALYSIS_PROMPT = fs.readFileSync(
  path.join(__dirname, '../config/ai-analysis-prompt.txt'),
  'utf-8'
);
console.log('[claudeService] Main prompt loaded, length:', CREDIT_ANALYSIS_PROMPT.length, 'chars');

const CHUNK_EXTRACTION_PROMPT = fs.readFileSync(
  path.join(__dirname, '../config/chunk-extraction-prompt.txt'),
  'utf-8'
);
console.log('[claudeService] Chunk extraction prompt loaded, length:', CHUNK_EXTRACTION_PROMPT.length, 'chars');

// ---------------------------------------------------------------------------
// Tool definition -- forces Claude to return structured output (unchanged)
// ---------------------------------------------------------------------------
const ANALYSIS_TOOL = {
  name: 'submit_credit_analysis',
  description: 'Submit the structured credit analysis result extracted from the uploaded report.',
  input_schema: {
    type: 'object',
    properties: {
      score:               { type: 'number' },
      score_band:          { type: 'string' },
      active_loans:        { type: 'number' },
      overdue_status:      { type: 'string' },
      enquiries_6m:        { type: 'number' },
      enquiries_rating:    { type: 'string' },
      foir_percent:        { type: 'number' },
      foir_rating:         { type: 'string' },
      max_eligible_amount: { type: 'number' },
      recommendation:      { type: 'string' },
    },
    required: [
      'score', 'score_band', 'active_loans', 'overdue_status',
      'enquiries_6m', 'foir_percent', 'max_eligible_amount', 'recommendation',
    ],
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
      enquiries_6m:          { type: 'number' },
      enquiries_12m:         { type: 'number' },
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
// extractChunkData
// One Claude call for one chunk. Retries once on failure, then throws with
// a page-range-specific error that is surfaced to the user.
// ---------------------------------------------------------------------------
async function extractChunkData(chunk, chunkIndex, totalChunks, analysisId) {
  const label = `[chunk ${chunkIndex + 1}/${totalChunks} pages ${chunk.startPage}-${chunk.endPage}]`;
  console.log(`[claudeService:${analysisId}] ${label} Starting extraction`);

  async function attempt() {
    const response = await anthropic.messages.create({
      model:      CLAUDE_MODEL,
      max_tokens: 8000,
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
    enquiries_6m:      null,
    enquiries_12m:     null,
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

    if (chunk.enquiries_6m  != null && merged.enquiries_6m  === null) merged.enquiries_6m  = chunk.enquiries_6m;
    if (chunk.enquiries_12m != null && merged.enquiries_12m === null) merged.enquiries_12m = chunk.enquiries_12m;

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
// After all chunks are merged, one final Claude call produces the 6 UI summary
// fields (score, FOIR, recommendation, etc.) from the merged JSON context.
// No PDF is sent -- just structured data. Uses the existing ANALYSIS_TOOL.
// ---------------------------------------------------------------------------
async function synthesizeFinalResult(mergedData, analysisId) {
  console.log(`[claudeService:${analysisId}] Synthesizing final result from merged data (${mergedData.total_accounts} accounts)...`);

  // Compact JSON context -- excludes full payment history arrays (too large)
  const context = {
    client_name:       mergedData.client_name,
    report_date:       mergedData.report_date,
    pan:               mergedData.pan,
    credit_score:      mergedData.credit_score,
    score_band:        mergedData.score_band,
    enquiries_6m:      mergedData.enquiries_6m,
    enquiries_12m:     mergedData.enquiries_12m,
    total_accounts:    mergedData.total_accounts,
    active_accounts:   mergedData.active_accounts,
    total_outstanding: mergedData.total_outstanding,
    total_overdue:     mergedData.total_overdue,
    total_sanctioned:  mergedData.total_sanctioned,
    total_written_off: mergedData.total_written_off,
    accounts: mergedData.accounts.map((a) => ({
      lender:                 a.lender,
      account_type:           a.account_type,
      status:                 a.status,
      sanctioned_amount:      a.sanctioned_amount,
      current_balance:        a.current_balance,
      overdue_amount:         a.overdue_amount,
      written_off_amount:     a.written_off_amount,
      max_dpd:                a.max_dpd,
      payment_history_months: (a.payment_history || []).length,
    })),
  };

  const response = await anthropic.messages.create({
    model:      CLAUDE_MODEL,
    max_tokens: 4000,
    system:     CREDIT_ANALYSIS_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'The following JSON contains structured credit data extracted from a multi-section credit report. ' +
              'Analyze this data and return the structured credit analysis result using the submit_credit_analysis tool.\n\n' +
              '```json\n' + JSON.stringify(context, null, 2) + '\n```',
          },
        ],
      },
    ],
    tools:       [ANALYSIS_TOOL],
    tool_choice: { type: 'tool', name: 'submit_credit_analysis' },
  });

  const toolBlock = response.content.find((c) => c.type === 'tool_use');
  if (!toolBlock) {
    console.error(`[claudeService:${analysisId}] synthesizeFinalResult: no tool_use block. Full response:`, JSON.stringify(response.content, null, 2));
    throw new Error('Synthesis call did not return a tool_use block');
  }

  console.log(`[claudeService:${analysisId}] Synthesis complete. Score: ${toolBlock.input.score}`);
  return toolBlock.input;
}

// ---------------------------------------------------------------------------
// processAnalysisInBackground
// Routes to single-call path (<=100 pages) or chunked path (>100 pages).
// The single-call path is byte-for-byte identical to the pre-chunking version.
// ---------------------------------------------------------------------------
async function processAnalysisInBackground(analysisId) {
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

    const useChunkedPath = pageCount !== null && pageCount > CHUNK_PAGE_LIMIT;

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
      console.log(`[claudeService:${analysisId}]   max_tokens: 4000`);

      let response;
      try {
        response = await anthropic.messages.create({
          model:      CLAUDE_MODEL,
          max_tokens: 4000,
          system:     CREDIT_ANALYSIS_PROMPT,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type:   'document',
                  source: { type: 'base64', media_type: mediaType, data: base64Data },
                },
                { type: 'text', text: 'Analyze this credit report and return the structured result.' },
              ],
            },
          ],
          tools:       [ANALYSIS_TOOL],
          tool_choice: { type: 'tool', name: 'submit_credit_analysis' },
        });
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
      console.log(`[claudeService:${analysisId}]   usage         :`, response.usage);

      const toolUseBlock = response.content.find((c) => c.type === 'tool_use');
      if (!toolUseBlock) {
        console.error(`[claudeService:${analysisId}] No tool_use block found in response.`);
        console.error(`[claudeService:${analysisId}] Full response content:`, JSON.stringify(response.content, null, 2));
        throw new Error('Model did not return structured output via tool call');
      }

      const result = toolUseBlock.input;
      console.log(`[claudeService:${analysisId}] Extracted structured result:`, JSON.stringify(result, null, 2));

      await AIAnalysis.findByIdAndUpdate(analysisId, {
        status:           'completed',
        isChunked:        false,
        rawModelResponse: response,
        debugError:       null,
        result: {
          score:             result.score,
          scoreBand:         result.score_band,
          activeLoans:       result.active_loans,
          overdueStatus:     result.overdue_status,
          enquiries6m:       result.enquiries_6m,
          enquiriesRating:   result.enquiries_rating,
          foirPercent:       result.foir_percent,
          foirRating:        result.foir_rating,
          maxEligibleAmount: result.max_eligible_amount,
          recommendation:    result.recommendation,
        },
      });
      console.log(`[claudeService:${analysisId}] Status -> completed (single-call path)`);
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

    // B4. Final synthesis call (produces the 6 UI summary fields from JSON)
    const finalResult = await synthesizeFinalResult(mergedData, analysisId);

    // B5. Persist completed result
    await AIAnalysis.findByIdAndUpdate(analysisId, {
      status:     'completed',
      isChunked:  true,
      mergedData, // stored so generateFullHtmlReport() can use it without re-reading the PDF
      debugError: null,
      result: {
        score:             finalResult.score,
        scoreBand:         finalResult.score_band,
        activeLoans:       finalResult.active_loans,
        overdueStatus:     finalResult.overdue_status,
        enquiries6m:       finalResult.enquiries_6m,
        enquiriesRating:   finalResult.enquiries_rating,
        foirPercent:       finalResult.foir_percent,
        foirRating:        finalResult.foir_rating,
        maxEligibleAmount: finalResult.max_eligible_amount,
        recommendation:    finalResult.recommendation,
      },
    });
    console.log(`[claudeService:${analysisId}] Status -> completed (chunked path)`);

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
    if (isPdfPageLimitError(err)) {
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
  }
}

// ---------------------------------------------------------------------------
// generateFullHtmlReport -- second Claude call, free-text HTML output.
// For SHORT files (isChunked=false): re-sends the PDF natively (unchanged).
// For LARGE files (isChunked=true): generates HTML from stored mergedData JSON.
// Both paths use the same system prompt and produce identical visual output.
// ---------------------------------------------------------------------------
async function generateFullHtmlReport(analysisId) {
  console.log(`\n${'~'.repeat(60)}`);
  console.log(`[htmlReport:${analysisId}] HTML generation started at ${new Date().toISOString()}`);
  console.log('~'.repeat(60));

  const analysis = await AIAnalysis.findById(analysisId);
  if (!analysis) throw new Error(`[htmlReport:${analysisId}] Analysis record not found`);
  if (analysis.status !== 'completed') {
    throw new Error(`[htmlReport:${analysisId}] Analysis is not completed (status: ${analysis.status})`);
  }

  console.log(`[htmlReport:${analysisId}] System prompt length : ${CREDIT_ANALYSIS_PROMPT.length} chars`);
  console.log(`[htmlReport:${analysisId}] isChunked: ${analysis.isChunked}`);

  // =========================================================================
  // PATH A -- SHORT FILE: re-send the PDF natively (unchanged behaviour)
  // =========================================================================
  if (!analysis.isChunked) {
    console.log(`[htmlReport:${analysisId}] Short-file path -- re-reading PDF for second Claude call`);

    let fileBuffer;
    try {
      fileBuffer = await fs.promises.readFile(analysis.filePath);
    } catch (fileErr) {
      console.error(`[htmlReport:${analysisId}] Failed to read file: ${analysis.filePath}`, fileErr);
      throw fileErr;
    }

    const base64Data = fileBuffer.toString('base64');
    const mediaType  = mime.lookup(analysis.filePath) || 'application/pdf';
    console.log(`[htmlReport:${analysisId}] File: ${analysis.filePath} | ${(fileBuffer.length / 1024).toFixed(1)} KB | ${mediaType}`);
    console.log(`[htmlReport:${analysisId}] Calling Claude API (short-file HTML mode) | model: ${CLAUDE_MODEL} | max_tokens: 25000`);

    let response;
    try {
      const stream = anthropic.messages.stream({
        model:      CLAUDE_MODEL,
        max_tokens: 25000,
        system:     CREDIT_ANALYSIS_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type:   'document',
                source: { type: 'base64', media_type: mediaType, data: base64Data },
              },
              {
                type: 'text',
                text: 'Generate the full HTML credit analysis report per the system prompt instructions.',
              },
            ],
          },
        ],
      });
      response = await stream.finalMessage();
    } catch (apiErr) {
      console.error(`[htmlReport:${analysisId}] Claude API call FAILED`);
      console.error(`[htmlReport:${analysisId}]   Error type    :`, apiErr.constructor && apiErr.constructor.name);
      console.error(`[htmlReport:${analysisId}]   Error message :`, apiErr.message);
      if (apiErr.status !== undefined) console.error(`[htmlReport:${analysisId}]   HTTP status   :`, apiErr.status);
      if (apiErr.error  !== undefined) console.error(`[htmlReport:${analysisId}]   API error body:`, JSON.stringify(apiErr.error, null, 2));
      throw apiErr;
    }

    return await _extractAndPersistHtml(response, analysisId);
  }

  // =========================================================================
  // PATH B -- LARGE FILE: generate HTML from stored mergedData JSON.
  // No PDF re-send. Uses the already-extracted structured data.
  // =========================================================================
  console.log(`[htmlReport:${analysisId}] Large-file path -- generating HTML from stored mergedData JSON`);

  if (!analysis.mergedData) {
    throw new Error(`[htmlReport:${analysisId}] isChunked=true but mergedData is missing from DB record`);
  }

  const mergedJson = JSON.stringify(analysis.mergedData, null, 2);
  console.log(`[htmlReport:${analysisId}] mergedData: ${mergedJson.length} chars, ${analysis.mergedData.total_accounts} accounts`);
  console.log(`[htmlReport:${analysisId}] Calling Claude API (large-file HTML mode) | model: ${CLAUDE_MODEL} | max_tokens: 25000`);

  let response;
  try {
    const stream = anthropic.messages.stream({
      model:      CLAUDE_MODEL,
      max_tokens: 25000,
      system:     CREDIT_ANALYSIS_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'The following JSON contains the complete structured credit data extracted from a multi-page credit bureau report. ' +
                'Generate the full HTML credit analysis report per the system prompt instructions, using ONLY this data. ' +
                'Follow the exact same template, sections, charts, and design as specified in the system prompt.\n\n' +
                '```json\n' + mergedJson + '\n```',
            },
          ],
        },
      ],
    });
    response = await stream.finalMessage();
  } catch (apiErr) {
    console.error(`[htmlReport:${analysisId}] Claude API call FAILED (large-file path)`);
    console.error(`[htmlReport:${analysisId}]   Error type    :`, apiErr.constructor && apiErr.constructor.name);
    console.error(`[htmlReport:${analysisId}]   Error message :`, apiErr.message);
    if (apiErr.status !== undefined) console.error(`[htmlReport:${analysisId}]   HTTP status   :`, apiErr.status);
    if (apiErr.error  !== undefined) console.error(`[htmlReport:${analysisId}]   API error body:`, JSON.stringify(apiErr.error, null, 2));
    throw apiErr;
  }

  return await _extractAndPersistHtml(response, analysisId);
}

// ---------------------------------------------------------------------------
// _extractAndPersistHtml -- shared post-processing for both HTML paths.
// Validates that the response is proper HTML, strips markdown fences, persists.
// ---------------------------------------------------------------------------
async function _extractAndPersistHtml(response, analysisId) {
  console.log(`[htmlReport:${analysisId}] Claude response received`);
  console.log(`[htmlReport:${analysisId}]   stop_reason   : ${response.stop_reason}`);
  console.log(`[htmlReport:${analysisId}]   content blocks: ${response.content.length}`);
  console.log(`[htmlReport:${analysisId}]   usage         :`, response.usage);

  const textBlock = response.content.find((c) => c.type === 'text');
  if (!textBlock) {
    console.error(`[htmlReport:${analysisId}] No text block in response. Full content:`, JSON.stringify(response.content, null, 2));
    throw new Error('Claude did not return a text block -- expected free-text HTML output');
  }

  let rawHtml = (textBlock.text || '').trim();
  console.log(`[htmlReport:${analysisId}] Raw HTML length: ${rawHtml.length} chars`);
  console.log(`[htmlReport:${analysisId}] First 300 chars:\n${rawHtml.slice(0, 300)}`);

  // Strip markdown code fences if Claude wrapped the HTML
  if (rawHtml.toLowerCase().startsWith('```html')) {
    rawHtml = rawHtml.substring(7);
  } else if (rawHtml.startsWith('```')) {
    rawHtml = rawHtml.substring(3);
  }
  if (rawHtml.endsWith('```')) {
    rawHtml = rawHtml.substring(0, rawHtml.length - 3);
  }
  rawHtml = rawHtml.trim();

  if (!rawHtml.toLowerCase().startsWith('<!doctype html>')) {
    console.error(`[htmlReport:${analysisId}] VALIDATION FAILED -- response does not start with <!DOCTYPE html>`);
    console.error(`[htmlReport:${analysisId}] Raw response first 500 chars:\n${rawHtml.slice(0, 500)}`);
    throw new Error(
      'Claude returned malformed output (does not start with <!DOCTYPE html>). ' +
      'Check server logs for the raw response.'
    );
  }

  await AIAnalysis.findByIdAndUpdate(analysisId, {
    htmlReport:     rawHtml,
    htmlGenerating: false,
  });
  console.log(`[htmlReport:${analysisId}] HTML report stored in DB (${rawHtml.length} chars)`);

  return rawHtml;
}

module.exports = { processAnalysisInBackground, generateFullHtmlReport };
