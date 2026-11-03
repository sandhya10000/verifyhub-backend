const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const BankStatementAnalysis = require('../models/BankStatementAnalysis');
const { canAfford, chargeForReport, chargeFailedReport } = require('../utils/wallet');
const { uploadStatement, getResult, downloadPdf } = require('../services/finpassBsa.service');
const { rebrandFinpassPdf } = require('../services/bsaPdfBranding.service');

// Rebranded reports live outside the public /uploads tree.
const PRIVATE_REPORT_DIR = path.join(__dirname, '..', 'private', 'bsa-reports');
fs.mkdirSync(PRIVATE_REPORT_DIR, { recursive: true });

const PROCESSING_TIMEOUT_MS = 15 * 60 * 1000;
const FINALIZING_STALE_MS = 2 * 60 * 1000;

const removeTmp = (filePath) => {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
};

const maskAccount = (num) => {
  const s = String(num || '');
  return s.length > 4 ? `${'X'.repeat(s.length - 4)}${s.slice(-4)}` : s || null;
};

// POST /api/bsa/analyze  (multipart: file)
// Free rejections (not a PDF, password-protected, no balance) happen before any
// Finpass call. Once Finpass accepts the upload the analysis is billed, whether
// it later succeeds or fails.
exports.analyze = async (req, res) => {
  const tmpPath = req.file?.path;
  try {
    const userId = req.user?._id;
    if (!userId) {
      removeTmp(tmpPath);
      return res.status(401).json({ success: false, message: 'User authentication required' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please upload the bank statement PDF.' });
    }

    // Password-protected PDFs cannot be read by Finpass with an empty password.
    try {
      await PDFDocument.load(fs.readFileSync(tmpPath));
    } catch {
      removeTmp(tmpPath);
      return res.status(400).json({
        success: false,
        code: 'PASSWORD_PROTECTED',
        message: 'This statement is password-protected. Please upload it without a password.',
      });
    }

    const gate = await canAfford(userId, 'bsa');
    if (!gate.ok && gate.reason !== 'user-not-found') {
      removeTmp(tmpPath);
      return res.status(402).json({
        success: false,
        message: `Insufficient wallet balance. ${gate.total} required — please recharge.`,
        required: gate.total,
        balance: gate.balance,
      });
    }

    const doc = await BankStatementAnalysis.create({
      userId,
      orderId: `bsa_${String(userId)}_${Date.now()}`,
      fileName: req.file.originalname,
      status: 'Processing',
    });

    try {
      const { clientId, docId } = await uploadStatement(tmpPath);
      doc.clientId = clientId;
      doc.docId = docId;
      await doc.save();
    } catch (err) {
      console.error('[bsa] Finpass upload failed:', err.code || '', err.message);
      // Not accepted by Finpass: nothing was analysed, so no charge.
      doc.status = 'Failed';
      doc.failureReason = err.code === 'CONFIG_MISSING'
        ? 'Bank statement service is not configured'
        : 'Could not upload the statement to the analysis service. Please try again.';
      doc.failureCategory = err.code === 'CONFIG_MISSING' ? 'AUTH_CONFIG' : 'NETWORK';
      doc.failedAt = new Date();
      await doc.save();
      removeTmp(tmpPath);
      return res.status(502).json({ success: false, id: doc._id, status: 'Failed', message: doc.failureReason });
    }

    // The statement has been handed to Finpass, so the local copy is no longer needed.
    removeTmp(tmpPath);
    return res.status(201).json({ success: true, id: doc._id, status: 'Processing' });
  } catch (err) {
    console.error('[bsa] analyze error:', err.message);
    removeTmp(tmpPath);
    return res.status(500).json({ success: false, message: 'Could not start the analysis. Please try again.' });
  }
};

// Marks the analysis Failed and bills it (provider accepted the upload).
async function failAndCharge(doc, reason, category, errorCode) {
  doc.status = 'Failed';
  doc.failureReason = reason;
  doc.failureCategory = category;
  doc.errorCode = errorCode || null;
  doc.failedAt = new Date();
  await doc.save();
  await chargeFailedReport(doc.userId, doc._id, 'bsa', 'BSA');
}

// GET /api/bsa/:id — polled by the page. While Processing it asks Finpass; when
// Finpass is done it downloads, rebrands and bills the report in this request,
// so the wallet is already debited when the page refreshes.
exports.getStatus = async (req, res) => {
  try {
    const doc = await BankStatementAnalysis.findById(req.params.id);
    if (!doc || String(doc.userId) !== String(req.user._id)) {
      return res.status(404).json({ success: false, message: 'Analysis not found' });
    }

    if (doc.status === 'Success' || doc.status === 'Failed') {
      return res.json({ success: true, data: publicView(doc) });
    }

    // Another poll is finishing this one; report it as still processing.
    if (doc.status === 'Finalizing') {
      const age = Date.now() - new Date(doc.updatedAt).getTime();
      if (age < FINALIZING_STALE_MS) {
        return res.json({ success: true, data: publicView(doc) });
      }
    }

    if (Date.now() - new Date(doc.createdAt).getTime() > PROCESSING_TIMEOUT_MS) {
      await failAndCharge(doc, 'The analysis took too long. Please try again.', 'TIMEOUT', 'TIMEOUT');
      return res.json({ success: true, data: publicView(doc) });
    }

    let result;
    try {
      result = await getResult(doc.clientId);
    } catch (err) {
      // Transient provider/network error: keep polling, do not bill yet.
      console.error('[bsa] result poll error:', err.message);
      return res.json({ success: true, data: publicView(doc) });
    }

    if (result?.status === 'failed' || result?.error_message) {
      await failAndCharge(doc, result.error_message || 'The analysis could not be completed.', 'BUREAU_REJECT', null);
      return res.json({ success: true, data: publicView(doc) });
    }

    if (!(result?.status === 'completed' && result?.analysis_completed && result?.analysis_pdf_s3_url)) {
      return res.json({ success: true, data: publicView(doc) });
    }

    // Claim the result so two concurrent polls cannot both finalize it.
    const claimed = await BankStatementAnalysis.findOneAndUpdate(
      { _id: doc._id, status: 'Processing' },
      { $set: { status: 'Finalizing' } },
      { new: true },
    );
    if (!claimed) {
      const again = await BankStatementAnalysis.findById(doc._id);
      return res.json({ success: true, data: publicView(again) });
    }

    try {
      const raw = await downloadPdf(result.analysis_pdf_s3_url);
      const { buffer, pageCount } = await rebrandFinpassPdf(raw);

      const relPath = `${String(doc._id)}.pdf`;
      fs.writeFileSync(path.join(PRIVATE_REPORT_DIR, relPath), buffer);

      const info = result.account_info || {};
      claimed.localPath = relPath;
      claimed.pageCount = pageCount;
      claimed.accountHolderName = info.account_holder_name || null;
      claimed.bankName = info.bank_name || null;
      claimed.accountNumberMasked = maskAccount(info.account_number);
      claimed.statementFrom = info.statement_period?.from || null;
      claimed.statementTo = info.statement_period?.to || null;
      claimed.bsaData = { account_info: { ...info, account_number: maskAccount(info.account_number) }, checkpoint: result.checkpoint };
      claimed.status = 'Success';
      await claimed.save();

      // Delivered: bill it once. chargeForReport is idempotent per reportId.
      await chargeForReport(claimed.userId, claimed._id, 'bsa', 'BSA');
      return res.json({ success: true, data: publicView(claimed) });
    } catch (err) {
      // Our branding/download step failed after Finpass finished. That is our
      // fault, so the partner is not billed.
      console.error('[bsa] finalize error:', err.code || '', err.message);
      claimed.status = 'Failed';
      claimed.failureReason = err.code === 'BRANDING_ANCHOR_MISSING'
        ? 'We could not prepare this report because its layout is not recognised yet. You have not been charged.'
        : 'We could not prepare the report. You have not been charged.';
      claimed.failureCategory = 'UNKNOWN';
      claimed.failedAt = new Date();
      await claimed.save();
      return res.json({ success: true, data: publicView(claimed) });
    }
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
exports.downloadReport = async (req, res) => {
  try {
    const doc = await BankStatementAnalysis.findById(req.params.id).select('userId status localPath fileName').lean();
    if (!doc || String(doc.userId) !== String(req.user._id)) {
      return res.status(404).json({ success: false, message: 'Report not found' });
    }
    if (doc.status !== 'Success' || !doc.localPath) {
      return res.status(409).json({ success: false, message: 'Report is not ready' });
    }
    const abs = path.join(PRIVATE_REPORT_DIR, path.basename(doc.localPath));
    if (!fs.existsSync(abs)) {
      return res.status(404).json({ success: false, message: 'Report file is missing' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="bank-statement-analysis-${doc._id}.pdf"`);
    return res.sendFile(abs);
  } catch (err) {
    console.error('[bsa] downloadReport error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not download the report.' });
  }
};

// GET /api/admin/bsa-reports?page&limit&search&partnerSearch&status&startDate&endDate
// Admin view across all partners. Read-only; no transaction or signed-link data.
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

// GET /api/admin/bsa-reports/:id/report — admin PDF download (route is admin-only).
exports.adminDownloadReport = async (req, res) => {
  try {
    const doc = await BankStatementAnalysis.findById(req.params.id).select('status localPath').lean();
    if (!doc || doc.status !== 'Success' || !doc.localPath) {
      return res.status(404).json({ success: false, message: 'Report not found' });
    }
    const abs = path.join(PRIVATE_REPORT_DIR, path.basename(doc.localPath));
    if (!fs.existsSync(abs)) return res.status(404).json({ success: false, message: 'Report file is missing' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="bank-statement-analysis-${doc._id}.pdf"`);
    return res.sendFile(abs);
  } catch (err) {
    console.error('[bsa] admin download error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not download the report.' });
  }
};

// What the partner sees. Never includes transactions or signed links.
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
