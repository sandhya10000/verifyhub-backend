const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const Anthropic = require('@anthropic-ai/sdk');
const AIAnalysis = require('../models/AIAnalysis');

// ---------------------------------------------------------------------------
// Validate critical env vars at startup so problems are visible immediately
// ---------------------------------------------------------------------------
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL   = process.env.CLAUDE_MODEL;

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
// Prompt
// ---------------------------------------------------------------------------
const CREDIT_ANALYSIS_PROMPT = fs.readFileSync(
  path.join(__dirname, '../config/ai-analysis-prompt.txt'),
  'utf-8'
);
console.log('[claudeService] Prompt loaded, length:', CREDIT_ANALYSIS_PROMPT.length, 'chars');

// ---------------------------------------------------------------------------
// Tool definition — forces Claude to return structured output
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
// Background job
// ---------------------------------------------------------------------------
async function processAnalysisInBackground(analysisId) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[claudeService:${analysisId}] Background job started at ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  const analysis = await AIAnalysis.findById(analysisId);
  if (!analysis) {
    console.error(`[claudeService:${analysisId}] Analysis record not found in DB — aborting.`);
    return;
  }

  try {
    // ---- 1. Mark as processing ----------------------------------------
    await AIAnalysis.findByIdAndUpdate(analysisId, { status: 'processing' });
    console.log(`[claudeService:${analysisId}] Status -> processing`);

    // ---- 2. Read & encode the uploaded file ----------------------------
    let fileBuffer;
    try {
      fileBuffer = await fs.promises.readFile(analysis.filePath);
    } catch (fileErr) {
      console.error(`[claudeService:${analysisId}] Failed to read file at path: ${analysis.filePath}`);
      console.error(`[claudeService:${analysisId}] File read error:`, fileErr);
      throw fileErr;
    }

    const base64Data = fileBuffer.toString('base64');
    const mediaType  = mime.lookup(analysis.filePath) || 'application/pdf';
    const fileSizeKB = (fileBuffer.length / 1024).toFixed(1);

    console.log(`[claudeService:${analysisId}] File ready`);
    console.log(`[claudeService:${analysisId}]   path      : ${analysis.filePath}`);
    console.log(`[claudeService:${analysisId}]   mediaType : ${mediaType}`);
    console.log(`[claudeService:${analysisId}]   size      : ${fileSizeKB} KB`);
    console.log(`[claudeService:${analysisId}]   base64 len: ${base64Data.length} chars`);

    // ---- 3. Call Claude -----------------------------------------------
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
      // Log the raw Anthropic API error in full so we can see exactly what
      // went wrong (wrong model name, bad key, rate-limit, quota, etc.)
      console.error(`[claudeService:${analysisId}] Claude API call FAILED`);
      console.error(`[claudeService:${analysisId}]   Error type    :`, apiErr.constructor && apiErr.constructor.name);
      console.error(`[claudeService:${analysisId}]   Error message :`, apiErr.message);
      if (apiErr.status !== undefined) {
        console.error(`[claudeService:${analysisId}]   HTTP status   :`, apiErr.status);
      }
      if (apiErr.error !== undefined) {
        console.error(`[claudeService:${analysisId}]   API error body:`, JSON.stringify(apiErr.error, null, 2));
      }
      if (apiErr.headers) {
        // Anthropic rate-limit headers are useful for diagnosing 429s
        const rl = {};
        for (const h of ['x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests', 'retry-after']) {
          if (apiErr.headers[h]) rl[h] = apiErr.headers[h];
        }
        if (Object.keys(rl).length) {
          console.error(`[claudeService:${analysisId}]   Rate-limit hdrs:`, rl);
        }
      }
      console.error(`[claudeService:${analysisId}]   Full error obj:`, apiErr);
      throw apiErr; // re-throw so outer catch stores it
    }

    console.log(`[claudeService:${analysisId}] Claude response received`);
    console.log(`[claudeService:${analysisId}]   stop_reason   : ${response.stop_reason}`);
    console.log(`[claudeService:${analysisId}]   content blocks: ${response.content.length}`);
    console.log(`[claudeService:${analysisId}]   usage         :`, response.usage);

    // ---- 4. Extract tool-use block ------------------------------------
    const toolUseBlock = response.content.find((c) => c.type === 'tool_use');
    if (!toolUseBlock) {
      console.error(`[claudeService:${analysisId}] No tool_use block found in response.`);
      console.error(`[claudeService:${analysisId}] Full response content:`, JSON.stringify(response.content, null, 2));
      throw new Error('Model did not return structured output via tool call');
    }

    const result = toolUseBlock.input;
    console.log(`[claudeService:${analysisId}] Extracted structured result:`, JSON.stringify(result, null, 2));

    // ---- 5. Persist completed result ----------------------------------
    await AIAnalysis.findByIdAndUpdate(analysisId, {
      status:           'completed',
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
    console.log(`[claudeService:${analysisId}] Status -> completed`);

  } catch (err) {
    // ------------------------------------------------------------------
    // FULL error logging — stack trace, type, HTTP status, API body.
    // Previously only err.message was logged; the real cause was invisible.
    // ------------------------------------------------------------------
    console.error('!'.repeat(60));
    console.error(`[claudeService:${analysisId}] BACKGROUND JOB FAILED at ${new Date().toISOString()}`);
    console.error(`[claudeService:${analysisId}]   Error type    :`, (err.constructor && err.constructor.name) || typeof err);
    console.error(`[claudeService:${analysisId}]   Error message :`, err.message);
    if (err.status !== undefined) {
      console.error(`[claudeService:${analysisId}]   HTTP status   :`, err.status);
    }
    if (err.error !== undefined) {
      console.error(`[claudeService:${analysisId}]   API error body:`, JSON.stringify(err.error, null, 2));
    }
    console.error(`[claudeService:${analysisId}]   Stack trace:\n`, err.stack);
    console.error('!'.repeat(60));

    // Build a debug string stored in DB — only surfaced to the client
    // when NODE_ENV !== 'production' (see getAnalysis controller)
    const debugError = [
      `Type: ${(err.constructor && err.constructor.name) || typeof err}`,
      `Message: ${err.message}`,
      err.status ? `HTTP status: ${err.status}` : null,
      err.error  ? `API body: ${JSON.stringify(err.error)}` : null,
      `Stack: ${err.stack}`,
    ].filter(Boolean).join('\n');

    await AIAnalysis.findByIdAndUpdate(analysisId, {
      status:       'failed',
      errorMessage: 'Analysis could not be completed. Please try again or contact support.',
      debugError,
    });
  }
}

// ---------------------------------------------------------------------------
// generateFullHtmlReport — second Claude call, free-text HTML output
// Called lazily on first "Download PDF" request for a completed analysis.
// Does NOT use tools or tool_choice — the system prompt drives HTML output.
// ---------------------------------------------------------------------------
async function generateFullHtmlReport(analysisId) {
  console.log(`\n${'~'.repeat(60)}`);
  console.log(`[htmlReport:${analysisId}] HTML generation started at ${new Date().toISOString()}`);
  console.log('~'.repeat(60));

  const analysis = await AIAnalysis.findById(analysisId);
  if (!analysis) {
    throw new Error(`[htmlReport:${analysisId}] Analysis record not found`);
  }
  if (analysis.status !== 'completed') {
    throw new Error(`[htmlReport:${analysisId}] Analysis is not completed (status: ${analysis.status})`);
  }

  // Debug: confirm which prompt content is being sent
  console.log(`[htmlReport:${analysisId}] System prompt length : ${CREDIT_ANALYSIS_PROMPT.length} chars`);
  console.log(`[htmlReport:${analysisId}] Prompt first 300 chars:\n${CREDIT_ANALYSIS_PROMPT.slice(0, 300)}`);
  console.log(`[htmlReport:${analysisId}] Prompt last  300 chars:\n${CREDIT_ANALYSIS_PROMPT.slice(-300)}`);

  // 1. Re-read the uploaded file
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

  // 2. Call Claude — free-text, no tool forcing
  console.log(`[htmlReport:${analysisId}] Calling Claude API (free-text HTML mode)...`);
  console.log(`[htmlReport:${analysisId}]   model      : ${CLAUDE_MODEL}`);
  console.log(`[htmlReport:${analysisId}]   max_tokens : 16000`);

  let response;
  try {
    response = await anthropic.messages.create({
      model:      CLAUDE_MODEL,
      max_tokens: 16000,
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
      // NO tools / tool_choice — let the system prompt drive free-text HTML output
    });
  } catch (apiErr) {
    console.error(`[htmlReport:${analysisId}] Claude API call FAILED`);
    console.error(`[htmlReport:${analysisId}]   Error type    :`, apiErr.constructor?.name);
    console.error(`[htmlReport:${analysisId}]   Error message :`, apiErr.message);
    if (apiErr.status !== undefined) console.error(`[htmlReport:${analysisId}]   HTTP status   :`, apiErr.status);
    if (apiErr.error  !== undefined) console.error(`[htmlReport:${analysisId}]   API error body:`, JSON.stringify(apiErr.error, null, 2));
    throw apiErr;
  }

  console.log(`[htmlReport:${analysisId}] Claude response received`);
  console.log(`[htmlReport:${analysisId}]   stop_reason   : ${response.stop_reason}`);
  console.log(`[htmlReport:${analysisId}]   content blocks: ${response.content.length}`);
  console.log(`[htmlReport:${analysisId}]   usage         :`, response.usage);

  // 3. Extract the text block
  const textBlock = response.content.find((c) => c.type === 'text');
  if (!textBlock) {
    console.error(`[htmlReport:${analysisId}] No text block in response. Full content:`,
      JSON.stringify(response.content, null, 2));
    throw new Error('Claude did not return a text block — expected free-text HTML output');
  }

  const rawHtml = (textBlock.text || '').trim();
  console.log(`[htmlReport:${analysisId}] Raw HTML length: ${rawHtml.length} chars`);
  console.log(`[htmlReport:${analysisId}] First 300 chars of response:\n${rawHtml.slice(0, 300)}`);

  // 4. Validate — must start with <!DOCTYPE html>
  if (!rawHtml.toLowerCase().startsWith('<!doctype html>')) {
    console.error(`[htmlReport:${analysisId}] VALIDATION FAILED — response does not start with <!DOCTYPE html>`);
    console.error(`[htmlReport:${analysisId}] Raw response first 500 chars:\n${rawHtml.slice(0, 500)}`);
    throw new Error(
      'Claude returned malformed output (does not start with <!DOCTYPE html>). ' +
      'Check server logs for the raw response.'
    );
  }

  // 5. Persist to DB
  await AIAnalysis.findByIdAndUpdate(analysisId, {
    htmlReport:     rawHtml,
    htmlGenerating: false,
  });
  console.log(`[htmlReport:${analysisId}] HTML report stored in DB (${rawHtml.length} chars)`);

  return rawHtml;
}

module.exports = { processAnalysisInBackground, generateFullHtmlReport };
