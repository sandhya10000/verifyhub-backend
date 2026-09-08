const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const AIAnalysis = require('../models/AIAnalysis');
const { processAnalysisInBackground, generateFullHtmlReport, processHtmlGenerationInBackground } = require('../utils/claudeService');

const { generateAnalysisPdf, generatePdfFromHtml } = require('../utils/pdfGenerator');
const { logStep } = require('../utils/logger');


exports.uploadReport = async (req, res) => {
  console.log('[uploadReport] Request received — userId:', req.user?._id, '| file:', req.file?.originalname);
  try {
    if (!req.file) {
      console.warn('[uploadReport] Rejected: no file in request');
      return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    if (path.extname(req.file.originalname).toLowerCase() === '.pdf') {
      const isEncrypted = await isPdfEncrypted(req.file.path);
      if (isEncrypted) {
        fs.unlinkSync(req.file.path);
        console.warn('[uploadReport] Rejected: PDF is password-protected');
        return res.status(400).json({
          success: false,
          message: 'This PDF is password-protected. Please remove the password and re-upload.',
        });
      }

      // -- Page-count gate: Anthropic caps at 100 pages per call, but
      // the chunked pipeline now handles files up to 2000 pages.
      // Only reject truly absurd files that would take 20+ Claude calls.
      const pageCount = await getPdfPageCount(req.file.path);
      console.log(`[uploadReport] PDF page count: ${pageCount}`);
      if (pageCount !== null && pageCount > 2000) {
        fs.unlinkSync(req.file.path);
        console.warn(`[uploadReport] Rejected: PDF has ${pageCount} pages (limit 2000)`);
        return res.status(400).json({
          success: false,
          message:
            `This report is too large to analyze (${pageCount} pages; maximum supported: 2000 pages). ` +
            'Please upload a shorter version of the report, or contact support.',
        });
      }
    }

    const analysis = await AIAnalysis.create({
      userId: req.user._id,
      fileName: req.file.originalname,
      filePath: req.file.path,
      fileType: path.extname(req.file.originalname).replace('.', ''),
      status: 'uploaded',
    });
    logStep(analysis._id, 'Upload Received', { fileName: req.file.originalname, sizeBytes: req.file.size });
    logStep(analysis._id, 'DB Record Created', { analysisId: analysis._id });

    console.log('[uploadReport] DB record created, analysisId:', analysis._id, '| filePath:', req.file.path);
    res.status(201).json({ success: true, analysisId: analysis._id, status: analysis.status });

    console.log('[uploadReport] Kicking off background Claude processing for analysisId:', analysis._id);
    logStep(analysis._id, 'Trigger Background Processing');
    processAnalysisInBackground(analysis._id);
  } catch (err) {
    console.error('[uploadReport] Unhandled error:', err);
    res.status(500).json({ success: false, message: 'Upload failed. Please try again.' });
  }
};

exports.getAnalysis = async (req, res) => {
  try {
    const analysis = await AIAnalysis.findById(req.params.id);
    if (!analysis) return res.status(404).json({ success: false, message: 'Analysis not found.' });

    if (String(analysis.userId) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    logStep(req.params.id, 'Frontend Polling Status', { status: analysis.status, htmlStatus: analysis.htmlStatus });

    const payload = {
      success: true,
      analysisId: analysis._id,
      status: analysis.status,
      errorMessage: analysis.errorMessage,
      isChunked: analysis.isChunked,
      chunkCount: analysis.chunkCount,
      chunksCompleted: analysis.chunksCompleted,
      result: analysis.status === 'completed' ? analysis.result : null,
      htmlStatus: analysis.htmlStatus,
    };

    // Expose the raw error details to the client in non-production so the
    // actual failure reason is visible without digging through server logs.
    if (process.env.NODE_ENV !== 'production' && analysis.debugError) {
      payload.debugError = analysis.debugError;
    }

    res.json(payload);
  } catch (err) {
    console.error('getAnalysis error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch analysis.' });
  }
};


exports.downloadPdf = async (req, res) => {
  const { id } = req.params;
  logStep(id, 'User Download Click Received');
  console.log(`[downloadPdf] Request for analysisId: ${id} | userId: ${req.user?._id}`);

  try {
    const analysis = await AIAnalysis.findById(id);
    if (!analysis) {
      return res.status(404).json({ success: false, message: 'Analysis not found.' });
    }
    if (String(analysis.userId) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }
    if (analysis.status !== 'completed') {
      return res.status(400).json({ success: false, message: 'Analysis is not ready yet.' });
    }

    // htmlReport is always stored atomically during processAnalysisInBackground().
    if (analysis.htmlStatus === 'failed' || !analysis.htmlReport) {
      console.error(`[downloadPdf:${id}] htmlReport is missing or failed (status: ${analysis.htmlStatus}).`);
      return res.status(422).json({
        success: false,
        message: 'Report generation failed. Please try again or contact support.',
      });
    }

    logStep(id, 'Download Serving htmlReport');
    console.log(`[downloadPdf:${id}] Serving htmlReport (${analysis.htmlReport.length} chars)`);
    return res.set({
      'Content-Type':        'text/html',
      'Content-Disposition': `attachment; filename="credit-analysis-${id}.html"`,
    }).send(analysis.htmlReport);

  } catch (err) {
    console.error(`[downloadPdf] Unhandled error for ${id}:`, err);
    res.status(500).json({ success: false, message: 'Could not generate PDF.' });
  }
};



exports.listAnalyses = async (req, res) => {
  try {
    const analyses = await AIAnalysis.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .select('-rawModelResponse -filePath');
    res.json({ success: true, data: analyses });
  } catch (err) {
    console.error('listAnalyses error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch analyses.' });
  }
};

async function isPdfEncrypted(filePath) {
  try {
    const bytes = fs.readFileSync(filePath);
    await PDFDocument.load(bytes);
    return false;
  } catch (err) {
    return true;
  }
}

// Returns the page count of a PDF, or null if it cannot be determined.
// Uses pdf-lib (already a project dependency) — lightweight, no full parsing.
async function getPdfPageCount(filePath) {
  try {
    const bytes = fs.readFileSync(filePath);
    // { ignoreEncryption: true } so we don't throw on encrypted files here
    // (the encryption check already runs before this is called).
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch (err) {
    // If we can't parse the file at all, let the rest of the pipeline handle it.
    console.warn('[getPdfPageCount] Could not determine page count:', err.message);
    return null;
  }
}
