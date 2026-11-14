const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const BankStatementAnalysis = require('../models/BankStatementAnalysis');
const walletUtil = require('../utils/wallet');

// Pipeline Modules
const pipelineExtractor = require('../utils/bankStatementExtractor');
const { classifyTransactions } = require('../utils/bankStatementClassifier');
const { computeBankAnalytics } = require('../utils/bankStatementEngine');
const { generateNarrative } = require('../utils/bankStatementNarrativeService');
const { renderBankStatementReportHtml } = require('../utils/bankStatementHtmlRenderer');
const pipelinePdf = require('../utils/pdfGenerator');

// Configurable private report directory
const PRIVATE_REPORT_DIR = process.env.REPORT_DIR || path.join(__dirname, '..', 'private', 'bsa-reports');
fs.mkdirSync(PRIVATE_REPORT_DIR, { recursive: true });

// Concurrency queue for background BSA jobs
const MAX_CONCURRENT_JOBS = parseInt(process.env.BSA_MAX_CONCURRENT_JOBS, 10) || 2;
let activeJobCount = 0;
const jobQueue = [];

function pumpJobQueue() {
  while (activeJobCount < MAX_CONCURRENT_JOBS && jobQueue.length > 0) {
    const nextJob = jobQueue.shift();
    activeJobCount++;
    (async () => {
      try {
        await executeStatementJob(nextJob.docId, nextJob.pdfBuffer, nextJob.originalFileName);
      } catch (err) {
        console.error(`[bsa-queue] Uncaught execution error for doc ${nextJob.docId}:`, err.message);
      } finally {
        activeJobCount--;
        setImmediate(pumpJobQueue);
      }
    })();
  }
}

function enqueueJob(docId, pdfBuffer, originalFileName) {
  jobQueue.push({ docId, pdfBuffer, originalFileName });
  pumpJobQueue();
}

const removeTmp = (filePath) => {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
};

const maskAccount = (num) => {
  const s = String(num || '').trim();
  return s.length > 4 ? `${'X'.repeat(s.length - 4)}${s.slice(-4)}` : s || null;
};

/**
 * Background Pipeline Worker
 * Runs under controlled concurrency queue.
 * Safe error handling prevents any unhandled rejections from crashing the server.
 */
async function executeStatementJob(docId, pdfBuffer, originalFileName) {
  let doc = null;
  try {
    doc = await BankStatementAnalysis.findById(docId);
    if (!doc) return;

    // 1. Extraction and Reconciliation Gate
    let extractionResult;
    try {
      extractionResult = await pipelineExtractor.extractAndReconcile(pdfBuffer, { allowPartial: false });
    } catch (err) {
      console.log(`[bsa] Extraction/Reconciliation stopped for doc ${docId}:`, err.message);
      doc.status = 'Failed';
      doc.failureReason = err.userMessage || err.message || 'The bank statement could not be parsed or reconciled cleanly. You have not been charged.';
      doc.failureCategory = 'VALIDATION';
      doc.errorCode = err.code || 'RECONCILIATION_FAILED';
      doc.failedAt = new Date();
      await doc.save();
      return;
    }

    const extractedData = extractionResult.data;

    // Transition to Finalizing
    doc.status = 'Finalizing';
    doc.pageCount = extractedData.pageCount || extractionResult.stats?.pageCount || 1;
    doc.accountHolderName = extractedData.accountHolderName || extractedData.accountProfile?.holderName || null;
    doc.bankName = extractedData.bankName || extractedData.accountProfile?.bankName || null;
    doc.accountNumberMasked = maskAccount(extractedData.accountNumber || extractedData.accountProfile?.accountNumberMasked);
    doc.statementFrom = extractedData.statementFrom || extractedData.accountProfile?.periodStart || null;
    doc.statementTo = extractedData.statementTo || extractedData.accountProfile?.periodEnd || null;
    await doc.save();

    // 2. Classification
    const classifiedTxs = await classifyTransactions(
      extractedData.transactions,
      extractedData.accountHolderName,
      { useClaudeFallback: true }
    );

    // 3. Analytics Engine
    const analytics = computeBankAnalytics(extractedData, classifiedTxs);

    // 4. Narrative Synthesis
    const narrative = await generateNarrative(analytics);

    // 5. HTML Rendering
    const html = renderBankStatementReportHtml({
      extractedData,
      analytics,
      narrative,
      classifiedTransactions: classifiedTxs,
      reportMetadata: {
        fileName: originalFileName,
        generatedAt: new Date().toLocaleString('en-IN', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'Asia/Kolkata',
        }),
      },
    });

    // 6. PDF Generation (Isolated Puppeteer runner)
    let pdfBufferGenerated;
    try {
      pdfBufferGenerated = await pipelinePdf.generatePdfFromHtml(html);
    } catch (pdfErr) {
      console.error(`[bsa] PDF generation failed for doc ${docId}:`, pdfErr.message);
      doc.status = 'Failed';
      doc.failureReason = 'Report PDF generation encountered an error. You have not been charged.';
      doc.failureCategory = 'UNKNOWN';
      doc.errorCode = 'PDF_GENERATION_FAILED';
      doc.failedAt = new Date();
      await doc.save();
      return;
    }

    const relFileName = `${String(doc._id)}.pdf`;
    const absPdfPath = path.join(PRIVATE_REPORT_DIR, relFileName);
    fs.writeFileSync(absPdfPath, pdfBufferGenerated);

    // Store rendered HTML alongside PDF so dynamic regeneration is always possible
    const htmlFileName = `${String(doc._id)}.html`;
    fs.writeFileSync(path.join(PRIVATE_REPORT_DIR, htmlFileName), html, 'utf8');

    // 7. Save Success State
    doc.status = 'Success';
    doc.localPath = relFileName;
    doc.bsaData = {
      kpis: analytics.kpis,
      scorecard: analytics.scorecard,
      obligations: analytics.recurringObligations,
      circularEvents: analytics.flaggedCircularEvents,
      creditCardRotations: analytics.creditCardRotations || [],
      bounceEvents: analytics.bounceEvents || [],
      internalMovements: analytics.internalMovements || { count: 0, totalCredits: 0, totalDebits: 0, items: [] },
      amlIndicators: analytics.amlIndicators,
      narrative,
      reconciliation: extractedData.reconciliation || null,
      audit: extractedData.audit || { repairs: [] },
    };
    await doc.save();

    // Charge wallet on success
    await walletUtil.chargeForReport(doc.userId, doc._id, 'bsa', 'BSA');
    console.log(`[bsa] Analysis completed successfully for doc ${docId}`);
  } catch (err) {
    console.error(`[bsa] Background processing error for doc ${docId}:`, err.message);
    if (doc) {
      try {
        doc.status = 'Failed';
        doc.failureReason = 'We could not prepare the report. You have not been charged.';
        doc.failureCategory = 'UNKNOWN';
        doc.failedAt = new Date();
        await doc.save();
      } catch (saveErr) {
        console.error(`[bsa] Failed to save failure state for doc ${docId}:`, saveErr.message);
      }
    }
  }
}

// POST /api/bsa/analyze  (multipart: file)
exports.analyze = async (req, res) => {
  const tmpPath = req.file?.path;
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User authentication required' });
    }
    if (!req.file || !tmpPath) {
      return res.status(400).json({ success: false, message: 'Please upload the bank statement PDF.' });
    }

    let fileBuffer;
    try {
      fileBuffer = fs.readFileSync(tmpPath);
    } catch (readErr) {
      return res.status(400).json({ success: false, message: 'Could not read uploaded statement file.' });
    }

    // Free rejections: Check valid PDF structure and password encryption upfront
    if (fileBuffer.slice(0, 5).toString('latin1') !== '%PDF-') {
      return res.status(400).json({
        success: false,
        code: 'INVALID_FORMAT',
        message: 'The uploaded file is not a valid PDF document.',
      });
    }

    try {
      await PDFDocument.load(fileBuffer);
    } catch (loadErr) {
      const errMsg = String(loadErr.message || '').toLowerCase();
      if (errMsg.includes('encrypt') || errMsg.includes('password')) {
        return res.status(400).json({
          success: false,
          code: 'PASSWORD_PROTECTED',
          message: 'This statement is password-protected. Please upload it without a password.',
        });
      }
      return res.status(400).json({
        success: false,
        code: 'INVALID_FORMAT',
        message: 'Corrupted or unreadable PDF structure.',
      });
    }

    // Free rejections: Check wallet affordability
    const gate = await walletUtil.canAfford(userId, 'bsa');
    if (!gate.ok && gate.reason !== 'user-not-found') {
      return res.status(402).json({
        success: false,
        message: `Insufficient wallet balance. ${gate.total} required — please recharge.`,
        required: gate.total,
        balance: gate.balance,
      });
    }

    // Create DB entry in Processing state
    const doc = await BankStatementAnalysis.create({
      userId,
      orderId: `bsa_${String(userId)}_${Date.now()}`,
      fileName: req.file.originalname,
      status: 'Processing',
    });

    // Enqueue job in concurrency queue
    enqueueJob(doc._id, fileBuffer, req.file.originalname);

    return res.status(201).json({ success: true, id: doc._id, status: 'Processing' });
  } catch (err) {
    console.error('[bsa] analyze error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not start the analysis. Please try again.' });
  } finally {
    // Temp upload cleanup: guarantee deletion in finally block on success, rejection, or error
    removeTmp(tmpPath);
  }
};

// GET /api/bsa/:id — polled by frontend
exports.getStatus = async (req, res) => {
  try {
    const doc = await BankStatementAnalysis.findById(req.params.id);
    if (!doc || String(doc.userId) !== String(req.user._id)) {
      return res.status(404).json({ success: false, message: 'Analysis not found' });
    }

    return res.json({ success: true, data: publicView(doc) });
  } catch (err) {
    console.error('[bsa] getStatus error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not fetch the analysis status.' });
  }
};

// GET /api/bsa/my-analyses?page&limit&search&status
exports.getMyAnalyses = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;
    const perPage = Math.min(parseInt(limit, 10) || 20, 100);
    const query = { userId: req.user._id };
    if (status === 'Success' || status === 'Failed') query.status = status;
    if (search) {
      const rx = { $regex: String(search).trim(), $options: 'i' };
      query.$or = [{ fileName: rx }, { accountHolderName: rx }, { bankName: rx }];
    }
    const [total, rows] = await Promise.all([
      BankStatementAnalysis.countDocuments(query),
      BankStatementAnalysis.find(query)
        .sort({ createdAt: -1 })
        .skip((parseInt(page, 10) - 1) * perPage)
        .limit(perPage)
        .select('-bsaData')
        .lean(),
    ]);
    return res.json({
      success: true,
      data: rows.map(publicView),
      total,
      page: parseInt(page, 10),
      pages: Math.ceil(total / perPage),
    });
  } catch (err) {
    console.error('[bsa] getMyAnalyses error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not load bank statement reports.' });
  }
};

// GET /api/bsa/:id/report — owner-only PDF download.
// If PDF is missing but HTML is stored, regenerates PDF on the fly.
exports.downloadReport = async (req, res) => {
  try {
    const doc = await BankStatementAnalysis.findById(req.params.id).select('userId status localPath fileName').lean();
    if (!doc || String(doc.userId) !== String(req.user._id)) {
      return res.status(404).json({ success: false, message: 'Report not found' });
    }
    if (doc.status !== 'Success') {
      return res.status(409).json({ success: false, message: 'Report is not ready' });
    }

    const pdfFileName = doc.localPath ? path.basename(doc.localPath) : `${String(doc._id)}.pdf`;
    const absPdfPath = path.join(PRIVATE_REPORT_DIR, pdfFileName);

    if (!fs.existsSync(absPdfPath)) {
      // Check if stored HTML exists to regenerate PDF on the fly
      const htmlPath = path.join(PRIVATE_REPORT_DIR, `${String(doc._id)}.html`);
      if (fs.existsSync(htmlPath)) {
        try {
          const htmlContent = fs.readFileSync(htmlPath, 'utf8');
          const regeneratedPdf = await pipelinePdf.generatePdfFromHtml(htmlContent);
          fs.writeFileSync(absPdfPath, regeneratedPdf);
        } catch (genErr) {
          console.error('[bsa] On-the-fly PDF regeneration failed:', genErr.message);
          return res.status(500).json({ success: false, message: 'Report PDF could not be regenerated.' });
        }
      } else {
        return res.status(404).json({ success: false, message: 'Report file is missing' });
      }
    }

    const stat = fs.statSync(absPdfPath);
    const isDownload = String(req.query.download || '') === '1';
    const dispositionType = isDownload ? 'attachment' : 'inline';
    const downloadName = `bank-statement-analysis-${doc._id}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `${dispositionType}; filename="${downloadName}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');

    const stream = fs.createReadStream(absPdfPath);
    stream.on('error', (streamErr) => {
      console.error('[bsa] stream error:', streamErr.message);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Error streaming report file' });
      }
    });
    return stream.pipe(res);
  } catch (err) {
    console.error('[bsa] downloadReport error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not download the report.' });
  }
};

// GET /api/admin/bsa-reports?page&limit&search&partnerSearch&status&startDate&endDate
exports.getAllBankStatementAnalyses = async (req, res) => {
  try {
    const User = require('../models/User');
    const { istDateRange } = require('../utils/istTime');
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const search = String(req.query.search || '').trim();
    const partnerSearch = String(req.query.partnerSearch || '').trim();
    const status = String(req.query.status || 'All');
    const { startDate, endDate } = req.query;

    const query = {};
    if (search) {
      const rx = { $regex: search, $options: 'i' };
      query.$or = [{ fileName: rx }, { accountHolderName: rx }, { bankName: rx }];
    }
    if (partnerSearch) {
      const users = await User.find({
        $or: [
          { name: { $regex: partnerSearch, $options: 'i' } },
          { email: { $regex: partnerSearch, $options: 'i' } },
          { partner_id: { $regex: partnerSearch, $options: 'i' } },
          { phone: { $regex: partnerSearch, $options: 'i' } },
        ],
      }).select('_id');
      query.userId = { $in: users.map((u) => u._id) };
    }
    if (status && status !== 'All') query.status = status;
    if (startDate || endDate) {
      const range = istDateRange(startDate, endDate);
      if (range) query.createdAt = range;
    }

    const [total, rows] = await Promise.all([
      BankStatementAnalysis.countDocuments(query),
      BankStatementAnalysis.find(query)
        .populate('userId', 'name email partner_id phone')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('-bsaData')
        .lean(),
    ]);
    return res.json({
      success: true,
      data: rows.map((r) => ({ ...publicView(r), userId: r.userId, orderId: r.orderId })),
      total,
      page,
      pages: Math.max(Math.ceil(total / limit), 1),
    });
  } catch (err) {
    console.error('[bsa] admin list error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not fetch bank statement reports' });
  }
};

// GET /api/admin/bsa-reports/:id/report — admin PDF download
exports.adminDownloadReport = async (req, res) => {
  try {
    const doc = await BankStatementAnalysis.findById(req.params.id).select('status localPath').lean();
    if (!doc || doc.status !== 'Success' || !doc.localPath) {
      return res.status(404).json({ success: false, message: 'Report not found' });
    }
    const abs = path.join(PRIVATE_REPORT_DIR, path.basename(doc.localPath));
    if (!fs.existsSync(abs)) return res.status(404).json({ success: false, message: 'Report file is missing' });

    const stat = fs.statSync(abs);
    const isDownload = String(req.query.download || '') === '1';
    const dispositionType = isDownload ? 'attachment' : 'inline';
    const downloadName = `bank-statement-analysis-${doc._id}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `${dispositionType}; filename="${downloadName}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');

    const stream = fs.createReadStream(abs);
    stream.on('error', (streamErr) => {
      console.error('[bsa] admin stream error:', streamErr.message);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Error streaming report file' });
      }
    });
    return stream.pipe(res);
  } catch (err) {
    console.error('[bsa] admin download error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not download the report.' });
  }
};

// What the partner sees. Retains identical shape as expected by frontend.
function publicView(doc) {
  const d = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: d._id,
    status: d.status,
    fileName: d.fileName,
    accountHolderName: d.accountHolderName,
    bankName: d.bankName,
    accountNumberMasked: d.accountNumberMasked,
    statementFrom: d.statementFrom,
    statementTo: d.statementTo,
    pageCount: d.pageCount,
    failureReason: d.failureReason,
    failureCategory: d.failureCategory,
    reportUrl: d.status === 'Success' ? `/api/bsa/${d._id}/report` : null,
    createdAt: d.createdAt,
  };
}

module.exports.executeStatementJob = executeStatementJob;
module.exports.enqueueJob = enqueueJob;
module.exports.getQueueStats = () => ({
  activeJobCount,
  queuedCount: jobQueue.length,
  maxConcurrent: MAX_CONCURRENT_JOBS,
});
