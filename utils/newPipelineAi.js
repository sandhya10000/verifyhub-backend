const fs = require('fs');
const mime = require('mime-types');
const AIAnalysis = require('../models/AIAnalysis');
const { renderCreditReport } = require('./reportRenderer');

const DISCOVERY_TOOL = {
  name: 'submit_document_discovery',
  description: 'Submit the discovered structure of the credit report document.',
  input_schema: {
    type: 'object',
    required: ['bureau', 'reportType', 'hasAccounts', 'hasEnquiries', 'accountCount', 'enquiryCount'],
    properties: {
      bureau: { type: 'string' },
      reportType: { type: 'string' },
      reportDate: { type: 'string' },
      customerName: { type: 'string' },
      dateOfBirth: { type: 'string' },
      pan: { type: 'string' },
      creditScore: { type: 'number' },
      scoreBand: { type: 'string' },
      accountCount: { type: 'number' },
      enquiryCount: { type: 'number' },
      sections: { type: 'array', items: { type: 'string' } },
      hasAccounts: { type: 'boolean' },
      hasEnquiries: { type: 'boolean' },
      hasPaymentHistory: { type: 'boolean' },
      layoutType: { type: 'string' }
    }
  }
};

const BATCH_EXTRACT_TOOL = {
  name: 'submit_batch_extraction',
  description: 'Submit a batch of extracted accounts and/or enquiries.',
  input_schema: {
    type: 'object',
    required: ['accounts', 'enquiries'],
    properties: {
      accounts: {
        type: 'array',
        items: {
          type: 'object',
          required: ['lender', 'masked_account_number', 'account_type'],
          properties: {
            lender: { type: 'string' },
            masked_account_number: { type: 'string' },
            account_type: { type: 'string' },
            ownership: { type: ['string', 'null'] },
            opened_date: { type: ['string', 'null'] },
            closed_date: { type: ['string', 'null'] },
            status: { type: ['string', 'null'] },
            sanctioned_amount: { type: ['number', 'null'] },
            current_balance: { type: ['number', 'null'] },
            overdue_amount: { type: ['number', 'null'] },
            emi_amount: { type: ['number', 'null'] },
            written_off_amount: { type: ['number', 'null'] },
            principal_written_off: { type: ['number', 'null'] },
            suit_filed: { type: ['boolean', 'null'] },
            max_dpd: { type: ['number', 'null'] },
            dpd_history: {
              type: 'array',
              items: {
                type: 'object',
                required: ['month', 'value'],
                properties: { month: { type: 'string' }, value: { type: 'string' } }
              }
            }
          }
        }
      },
      enquiries: {
        type: 'array',
        items: {
          type: 'object',
          required: ['member', 'date'],
          properties: {
            member: { type: 'string' },
            date: { type: 'string' },
            purpose: { type: ['string', 'null'] },
            amount: { type: ['number', 'null'] }
          }
        }
      }
    }
  }
};

async function executePipeline(analysisId, language, anthropic, CLAUDE_MODEL, saveToCreditReport, debitAiPull, buildLanguageInstruction, QUALITATIVE_TOOL) {
  console.log(`[newPipeline:${analysisId}] Starting new robust pipeline...`);
  const analysis = await AIAnalysis.findById(analysisId);
  if (!analysis) return;

  await AIAnalysis.findByIdAndUpdate(analysisId, { status: 'processing' });
  const fileBuffer = await fs.promises.readFile(analysis.filePath);
  const mediaType = mime.lookup(analysis.filePath) || 'application/pdf';
  const base64Data = fileBuffer.toString('base64');
  
  // 1. Document Discovery
  console.log(`[newPipeline:${analysisId}] Running Document Discovery...`);
  const docMsg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    system: "You are a credit report analysis AI. First, analyze the structure of this document. Identify the bureau, basic customer details, total number of accounts (or tradelines/loans), and total number of enquiries.",
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64Data } },
          { type: 'text', text: "Discover the document structure and return the metadata using the submit_document_discovery tool." }
        ]
      }
    ],
    tools: [DISCOVERY_TOOL],
    tool_choice: { type: 'tool', name: 'submit_document_discovery' }
  });

  const discoveryBlock = docMsg.content.find(c => c.type === 'tool_use');
  if (!discoveryBlock) throw new Error("Document discovery failed to use tool.");
  const discovery = discoveryBlock.input;
  console.log(`[newPipeline:${analysisId}] Discovery: Accounts=${discovery.accountCount}, Enquiries=${discovery.enquiryCount}, Bureau=${discovery.bureau}`);

  // 2. Batch Extraction for Accounts
  let allAccounts = [];
  let accountsToExtract = discovery.accountCount || 0;
  
  if (discovery.hasAccounts && accountsToExtract > 0) {
    let extractedAccountCount = 0;
    let currentBatchSize = 15; // Start with 15
    let maxRetries = 3;

    while (extractedAccountCount < accountsToExtract && currentBatchSize > 0) {
      console.log(`[newPipeline:${analysisId}] Extracting Accounts: ${extractedAccountCount}/${accountsToExtract} (Batch size: ${currentBatchSize})`);
      try {
        const batchMsg = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 8000,
          system: "You are a precise data extractor. Extract the credit accounts from the document exactly as requested.",
          messages: [
            {
              role: 'user',
              content: [
                { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64Data } },
                { type: 'text', text: `Extract the NEXT ${currentBatchSize} accounts starting after account index ${extractedAccountCount}. If there are fewer than ${currentBatchSize} left, extract all remaining. Extract ONLY accounts. Return using the submit_batch_extraction tool.` }
              ]
            }
          ],
          tools: [BATCH_EXTRACT_TOOL],
          tool_choice: { type: 'tool', name: 'submit_batch_extraction' }
        });

        if (batchMsg.stop_reason === 'max_tokens') {
          console.warn(`[newPipeline:${analysisId}] max_tokens hit for accounts batch size ${currentBatchSize}. Retrying with half size.`);
          currentBatchSize = Math.max(1, Math.floor(currentBatchSize / 2));
          continue;
        }

        const extractBlock = batchMsg.content.find(c => c.type === 'tool_use');
        if (!extractBlock || !extractBlock.input.accounts) {
          throw new Error("Invalid output format during account extraction.");
        }

        const newAccounts = extractBlock.input.accounts;
        if (newAccounts.length === 0) {
          console.warn(`[newPipeline:${analysisId}] Claude returned 0 accounts. Stopping account extraction.`);
          break;
        }

        allAccounts.push(...newAccounts);
        extractedAccountCount += newAccounts.length;

      } catch (err) {
        console.error(`[newPipeline:${analysisId}] Account extraction error:`, err);
        if (--maxRetries <= 0) break;
      }
    }
  }

  // 3. Batch Extraction for Enquiries
  let allEnquiries = [];
  let enquiriesToExtract = discovery.enquiryCount || 0;
  
  if (discovery.hasEnquiries && enquiriesToExtract > 0) {
    let extractedEnquiryCount = 0;
    let currentBatchSize = 40; // Enquiries are smaller, can batch more
    let maxRetries = 3;

    while (extractedEnquiryCount < enquiriesToExtract && currentBatchSize > 0) {
      console.log(`[newPipeline:${analysisId}] Extracting Enquiries: ${extractedEnquiryCount}/${enquiriesToExtract} (Batch size: ${currentBatchSize})`);
      try {
        const batchMsg = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 8000,
          system: "You are a precise data extractor. Extract the enquiries from the document exactly as requested.",
          messages: [
            {
              role: 'user',
              content: [
                { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64Data } },
                { type: 'text', text: `Extract the NEXT ${currentBatchSize} enquiries starting after enquiry index ${extractedEnquiryCount}. If there are fewer than ${currentBatchSize} left, extract all remaining. Extract ONLY enquiries. Return using the submit_batch_extraction tool.` }
              ]
            }
          ],
          tools: [BATCH_EXTRACT_TOOL],
          tool_choice: { type: 'tool', name: 'submit_batch_extraction' }
        });

        if (batchMsg.stop_reason === 'max_tokens') {
          console.warn(`[newPipeline:${analysisId}] max_tokens hit for enquiries batch size ${currentBatchSize}. Retrying with half size.`);
          currentBatchSize = Math.max(1, Math.floor(currentBatchSize / 2));
          continue;
        }

        const extractBlock = batchMsg.content.find(c => c.type === 'tool_use');
        if (!extractBlock || !extractBlock.input.enquiries) {
          throw new Error("Invalid output format during enquiry extraction.");
        }

        const newEnquiries = extractBlock.input.enquiries;
        if (newEnquiries.length === 0) {
          console.warn(`[newPipeline:${analysisId}] Claude returned 0 enquiries. Stopping enquiry extraction.`);
          break;
        }

        allEnquiries.push(...newEnquiries);
        extractedEnquiryCount += newEnquiries.length;

      } catch (err) {
        console.error(`[newPipeline:${analysisId}] Enquiry extraction error:`, err);
        if (--maxRetries <= 0) break;
      }
    }
  }

  // 4. Synthesize Qualitative Data
  console.log(`[newPipeline:${analysisId}] Synthesizing qualitative data...`);
  const compactContext = {
    client_name: discovery.customerName,
    credit_score: discovery.creditScore,
    total_accounts: allAccounts.length,
    total_outstanding: allAccounts.reduce((s, a) => s + (a.current_balance || 0), 0),
    total_overdue: allAccounts.reduce((s, a) => s + (a.overdue_amount || 0), 0),
    accounts: allAccounts.map(a => ({
      lender: a.lender,
      account_type: a.account_type,
      status: a.status,
      current_balance: a.current_balance,
      overdue_amount: a.overdue_amount,
      max_dpd: a.max_dpd
    }))
  };

  const qualMsg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 5000,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'You are a senior credit analyst. Produce a qualitative analysis using the submit_qualitative_analysis tool.\n\n```json\n' + JSON.stringify(compactContext, null, 2) + '\n```' + buildLanguageInstruction(language) }] }
    ],
    tools: [QUALITATIVE_TOOL],
    tool_choice: { type: 'tool', name: 'submit_qualitative_analysis' }
  });

  const qualBlock = qualMsg.content.find(c => c.type === 'tool_use');
  if (!qualBlock) throw new Error("Qualitative analysis failed.");
  const qualFields = qualBlock.input;

  // 5. Merge and Render
  const fullData = {
    client_name: discovery.customerName,
    report_date: discovery.reportDate,
    pan: discovery.pan,
    dob: discovery.dateOfBirth,
    bureau_control_no: null,
    credit_score: discovery.creditScore,
    score_band: discovery.scoreBand,
    language,
    accounts: allAccounts,
    enquiries: allEnquiries,
    ...qualFields
  };

  console.log(`[newPipeline:${analysisId}] Rendering HTML...`);
  const htmlReport = await renderCreditReport(fullData);

  console.log(`[newPipeline:${analysisId}] Saving and finalizing...`);
  await saveToCreditReport(analysisId, analysis.userId, fullData);

  const activeLoans = allAccounts.filter(a => (a.status || '').toLowerCase() === 'active').length;
  const hasOverdue = allAccounts.some(a => (a.overdue_amount || 0) > 0);

  await AIAnalysis.findByIdAndUpdate(analysisId, {
    status: 'completed',
    isChunked: true, // Mark chunked since we batched it
    mergedData: fullData,
    debugError: null,
    result: {
      score: fullData.credit_score,
      scoreBand: fullData.score_band,
      activeLoans,
      overdueStatus: hasOverdue ? 'Overdue' : 'Clear',
      foirPercent: qualFields.foir_percent,
      foirRating: qualFields.foir_rating,
      maxEligibleAmount: qualFields.max_eligible_amount,
      recommendation: qualFields.recommendation
    },
    htmlReport,
    htmlGenerating: false,
    htmlStatus: htmlReport ? 'completed' : 'failed'
  });

  await debitAiPull(analysis.userId, analysisId);
  console.log(`[newPipeline:${analysisId}] Finished successfully.`);
}

module.exports = { executePipeline };
