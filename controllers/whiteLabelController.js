'use strict';
// White-label (custom branded report) workflow for the brand designer and admins.
// Lists paid requests, lets the designer build/replace the partner's BrandProfile,
// and marks the setup Done (which activates the partner for branded uploads).

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const CustomBrandedRequest = require('../models/CustomBrandedRequest');
const BrandProfile = require('../models/BrandProfile');
const AIAnalysis = require('../models/AIAnalysis');
const User = require('../models/User');
const { validateBrand } = require('../utils/reportRenderer');
const { sendCbrReadyMail } = require('../utils/sendMail');

const BRAND_ASSETS_DIR = path.join(__dirname, '..', 'brand-assets');
const SETUP_STATUSES = ['not_started', 'in_progress', 'done'];
const MAX_PAGE_LIMIT = 100;
const EXPORT_LIMIT = 5000;
const PARTNER_REPORTS_LIMIT = 200;

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function partnerCodeOf(user) {
  return String(user.partner_id || user._id).toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

// IST day boundaries for YYYY-MM-DD inputs.
function istDay(value, endOfDay) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+05:30`);
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const SPARK_DAYS = 14;
const TREND_BUCKETS = ['total', 'not_started', 'in_progress', 'done'];

// Trend + sparkline data for the summary cards. Ignores list filters on purpose:
// the cards always show overall movement (this IST month vs last, last 14 days).
async function buildTrends() {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const thisMonthKey = `${y}-${String(m + 1).padStart(2, '0')}`;
  const lastMonthKey = m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, '0')}`;
  const lastMonthStart = new Date(Date.UTC(y, m - 1, 1) - IST_OFFSET_MS);

  const days = [];
  for (let i = SPARK_DAYS - 1; i >= 0; i -= 1) {
    days.push(new Date(ist.getTime() - i * 86400000).toISOString().slice(0, 10));
  }

  const rows = await CustomBrandedRequest.aggregate([
    { $match: { paymentStatus: 'Paid', createdAt: { $gte: lastMonthStart } } },
    {
      $group: {
        _id: {
          status: { $ifNull: ['$setupStatus', 'not_started'] },
          day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } },
          month: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'Asia/Kolkata' } },
        },
        count: { $sum: 1 },
      },
    },
  ]);

  const out = {};
  for (const b of TREND_BUCKETS) {
    out[b] = { thisMonth: 0, lastMonth: 0, daily: Object.fromEntries(days.map((d) => [d, 0])) };
  }
  for (const r of rows) {
    const { status, day, month } = r._id;
    for (const b of [status, 'total']) {
      if (!out[b]) continue;
      if (month === thisMonthKey) out[b].thisMonth += r.count;
      if (month === lastMonthKey) out[b].lastMonth += r.count;
      if (day in out[b].daily) out[b].daily[day] += r.count;
    }
  }

  const result = {};
  for (const b of TREND_BUCKETS) {
    const { thisMonth, lastMonth, daily } = out[b];
    // Null when last month had no requests, so the UI can show "—" rather than a fake %.
    const pct = lastMonth > 0 ? Math.round(((thisMonth - lastMonth) / lastMonth) * 1000) / 10 : null;
    result[b] = { pct, spark: days.map((d) => daily[d]) };
  }
  return result;
}

async function buildBaseFilter(query) {
  const filter = { paymentStatus: 'Paid' };
  const from = istDay(query.startDate, false);
  const to = istDay(query.endDate, true);
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }
  if (query.partnerSearch && String(query.partnerSearch).trim()) {
    const rx = { $regex: escapeRegex(String(query.partnerSearch).trim()), $options: 'i' };
    const ids = await User.find({
      role: 'user',
      $or: [{ name: rx }, { email: rx }, { partner_id: rx }, { phone: rx }],
    }).select('_id').lean();
    filter.partnerId = { $in: ids.map((u) => u._id) };
  }
  return filter;
}

// Legacy rows may lack setupStatus; treat them as not_started.
function withSetupFilter(base, setupStatus) {
  if (!SETUP_STATUSES.includes(setupStatus)) return { ...base };
  if (setupStatus === 'not_started') return { ...base, setupStatus: { $in: ['not_started', null] } };
  return { ...base, setupStatus };
}

const PARTNER_FIELDS = 'name email phone partner_id brandingStatus brandingPaidAt';

// GET /api/white-label
async function listRequests(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const base = await buildBaseFilter(req.query);
    const filter = withSetupFilter(base, req.query.setupStatus);

    const [total, rows, counts, trends] = await Promise.all([
      CustomBrandedRequest.countDocuments(filter),
      CustomBrandedRequest.find(filter)
        .populate('partnerId', PARTNER_FIELDS)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      CustomBrandedRequest.aggregate([
        { $match: base },
        { $group: { _id: '$setupStatus', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
      ]),
      buildTrends(),
    ]);

    const summary = { total: 0, totalAmount: 0, not_started: 0, in_progress: 0, done: 0, trends };
    for (const c of counts) {
      const key = c._id || 'not_started';
      summary[key] = (summary[key] || 0) + c.count;
      summary.total += c.count;
      summary.totalAmount += c.amount || 0;
    }

    return res.json({
      success: true,
      data: rows,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      summary,
    });
  } catch (err) {
    console.error('[whiteLabel] listRequests error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load white-label requests.' });
  }
}

// GET /api/white-label/export  — CSV of the same filters (no paging, capped)
async function exportRequestsCsv(req, res) {
  try {
    const filter = withSetupFilter(await buildBaseFilter(req.query), req.query.setupStatus);
    const rows = await CustomBrandedRequest.find(filter)
      .populate('partnerId', PARTNER_FIELDS)
      .sort({ createdAt: -1 })
      .limit(EXPORT_LIMIT)
      .lean();

    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      'Request ID', 'Created (ISO)', 'Partner', 'Partner ID', 'Email', 'Phone',
      'Payment method', 'Amount', 'Payment status', 'Setup status', 'Setup completed (ISO)',
      'Revisions used', 'Firm name (submitted)',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      const p = r.partnerId || {};
      lines.push([
        r.requestId, r.createdAt ? new Date(r.createdAt).toISOString() : '', p.name, p.partner_id,
        r.email || p.email, r.phone || p.phone, r.paymentMethod, r.amount, r.paymentStatus,
        r.setupStatus || 'not_started', r.setupCompletedAt ? new Date(r.setupCompletedAt).toISOString() : '',
        r.brandingDetails?.revisionsUsed || 0, r.brandingDetails?.companyName || '',
      ].map(esc).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="white-label-requests.csv"');
    return res.send(lines.join('\n'));
  } catch (err) {
    console.error('[whiteLabel] export error:', err);
    return res.status(500).json({ success: false, message: 'Export failed.' });
  }
}

// GET /api/white-label/:id
async function getRequestDetail(req, res) {
  try {
    const request = await CustomBrandedRequest.findById(req.params.id)
      .populate('partnerId', PARTNER_FIELDS)
      .lean();
    if (!request) return res.status(404).json({ success: false, message: 'Request not found.' });

    const partnerObjId = request.partnerId?._id || request.partnerId;
    const profile = await BrandProfile.findOne({ partnerId: partnerObjId, isActive: true })
      .sort({ version: -1 })
      .lean();

    return res.json({ success: true, data: { request, profile: profile || null } });
  } catch (err) {
    console.error('[whiteLabel] getRequestDetail error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load request.' });
  }
}

// GET /api/white-label/partners/:partnerId/reports
// Partner details plus every white-label (branded) AI report they generated.
// Report links reuse the existing ai-analyzer endpoints, which allow admins.
async function getPartnerGeneratedReports(req, res) {
  try {
    const { partnerId } = req.params;
    if (!mongoose.isValidObjectId(partnerId)) {
      return res.status(400).json({ success: false, message: 'Invalid partner id.' });
    }
    const partner = await User.findById(partnerId).select(PARTNER_FIELDS).lean();
    if (!partner) return res.status(404).json({ success: false, message: 'Partner not found.' });

    const filter = { userId: partner._id, isBranded: true };
    const [total, reports] = await Promise.all([
      AIAnalysis.countDocuments(filter),
      AIAnalysis.find(filter)
        .sort({ createdAt: -1 })
        .limit(PARTNER_REPORTS_LIMIT)
        .select('-rawModelResponse -filePath -htmlReport')
        .populate('brandProfileId', 'firmName version')
        .lean(),
    ]);

    // Size is not stored on the record; read it from the uploaded file when still present.
    const { UPLOAD_DIR } = require('../config/uploadConfig');
    const sizeOf = (storedFileName) => {
      try {
        const name = path.basename(storedFileName || '');
        return name ? fs.statSync(path.join(UPLOAD_DIR, name)).size : null;
      } catch {
        return null;
      }
    };
    const withSize = reports.map((r) => ({ ...r, fileSize: sizeOf(r.storedFileName) }));

    return res.json({ success: true, data: { partner, reports: withSize, total } });
  } catch (err) {
    console.error('[whiteLabel] getPartnerGeneratedReports error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load generated reports.' });
  }
}

function writeLogoFile(partnerCode, buffer, mime) {
  const dir = path.join(BRAND_ASSETS_DIR, partnerCode);
  fs.mkdirSync(dir, { recursive: true });
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  // resolveBrandLogo() prefers files on disk, so drop any stale variant first.
  for (const e of ['png', 'jpg', 'jpeg']) {
    const f = path.join(dir, `logo.${e}`);
    if (e !== ext && fs.existsSync(f)) fs.unlinkSync(f);
  }
  fs.writeFileSync(path.join(dir, `logo.${ext}`), buffer);
}

// PUT /api/white-label/:id/profile  (multipart: optional `logo` file + text fields)
// Creates a new BrandProfile version and deactivates the previous one.
async function saveBrandProfile(req, res) {
  try {
    const request = await CustomBrandedRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false, message: 'Request not found.' });
    if (request.paymentStatus !== 'Paid') {
      return res.status(400).json({ success: false, message: 'This request has not been paid.' });
    }

    const partner = await User.findById(request.partnerId).select('name email phone partner_id').lean();
    if (!partner) return res.status(404).json({ success: false, message: 'Partner not found.' });
    const partnerId = partner._id;
    const partnerCode = partnerCodeOf(partner);

    const existing = await BrandProfile.findOne({ partnerId, isActive: true }).sort({ version: -1 }).lean();
    const body = req.body || {};
    const pick = (key, fallback) => {
      const v = body[key];
      return v !== undefined && String(v).trim() !== '' ? String(v).trim() : fallback;
    };

    let logo = existing?.logo || null;
    if (req.file) {
      const mime = req.file.mimetype;
      if (mime !== 'image/png' && mime !== 'image/jpeg') {
        return res.status(400).json({ success: false, message: 'Logo must be a PNG or JPEG image.' });
      }
      logo = {
        dataUri: `data:${mime};base64,${req.file.buffer.toString('base64')}`,
        mimeType: mime,
        width: 0,
        height: 0,
      };
      writeLogoFile(partnerCode, req.file.buffer, mime);
    }
    if (!logo) return res.status(400).json({ success: false, message: 'A logo is required.' });

    const doc = {
      partnerCode,
      firmName: pick('firmName', existing?.firmName || partner.name),
      tagline: pick('tagline', existing?.tagline || ''),
      logo,
      colors: {
        primary: pick('primaryColor', existing?.colors?.primary),
        secondary: pick('secondaryColor', existing?.colors?.secondary),
        accent: pick('accentColor', existing?.colors?.accent),
      },
      email: pick('email', existing?.email || partner.email || '').toLowerCase(),
      website: pick('website', existing?.website || process.env.BRAND_WEBSITE_FALLBACK || 'https://verifyhub.in'),
      phone: pick('phone', existing?.phone || ''),
      whatsapp: pick('whatsapp', existing?.whatsapp || ''),
      address: pick('address', existing?.address || ''),
    };

    try {
      validateBrand({ ...doc, logo: { ...doc.logo } });
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    const latest = await BrandProfile.findOne({ partnerId }).sort({ version: -1 }).lean();
    const version = (latest?.version || 0) + 1;
    await BrandProfile.updateMany({ partnerId, isActive: true }, { $set: { isActive: false } });
    const profile = await BrandProfile.create({ ...doc, partnerId, version, isActive: true });

    if (!request.setupStatus || request.setupStatus === 'not_started') {
      request.setupStatus = 'in_progress';
      await request.save();
    }

    return res.json({ success: true, data: profile });
  } catch (err) {
    console.error('[whiteLabel] saveBrandProfile error:', err);
    return res.status(500).json({ success: false, message: 'Failed to save brand profile.' });
  }
}

// PUT /api/white-label/:id/status  body: { setupStatus?, internalNotes? }
// Done requires a valid active profile; it activates the partner for branded uploads.
async function updateSetupStatus(req, res) {
  try {
    const { setupStatus, internalNotes } = req.body || {};
    if (setupStatus !== undefined && !SETUP_STATUSES.includes(setupStatus)) {
      return res.status(400).json({ success: false, message: 'Invalid setupStatus.' });
    }

    const request = await CustomBrandedRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false, message: 'Request not found.' });
    if (request.paymentStatus !== 'Paid') {
      return res.status(400).json({ success: false, message: 'This request has not been paid.' });
    }
    const user = await User.findById(request.partnerId).select('name email partner_id brandingStatus').lean();
    if (!user) return res.status(404).json({ success: false, message: 'Partner not found.' });

    if (internalNotes !== undefined) {
      request.internalNotes = String(internalNotes).slice(0, 2000);
    }

    if (setupStatus === 'done') {
      const profile = await BrandProfile.findOne({ partnerId: user._id, isActive: true })
        .sort({ version: -1 })
        .lean();
      if (!profile) {
        return res.status(400).json({ success: false, message: 'Save a brand profile before marking this request done.' });
      }
      try {
        validateBrand({ ...profile, logo: { ...profile.logo } });
      } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
      }

      request.setupStatus = 'done';
      request.setupCompletedAt = new Date();
      request.setupCompletedBy = req.user._id;
      request.status = 'Completed';
      await request.save();

      await User.updateOne({ _id: user._id }, { $set: { brandingStatus: 'active' } });

      sendCbrReadyMail(user.email, {
        name: user.name,
        requestId: request.requestId,
        firmName: profile.firmName,
        partnerId: user.partner_id,
        completedAt: request.setupCompletedAt,
      }).catch((e) => console.error('[mail] CBR ready mail failed:', e.message));
    } else if (setupStatus) {
      const wasDone = request.setupStatus === 'done';
      request.setupStatus = setupStatus;
      request.setupCompletedAt = null;
      request.setupCompletedBy = null;
      if (request.status === 'Completed') request.status = 'Active';
      await request.save();

      // Reopening a finished setup pulls the partner back out of 'active'.
      if (wasDone && user.brandingStatus === 'active') {
        await User.updateOne({ _id: user._id }, { $set: { brandingStatus: 'onboarding' } });
      }
    } else {
      await request.save();
    }

    const fresh = await CustomBrandedRequest.findById(request._id).lean();
    return res.json({ success: true, data: fresh });
  } catch (err) {
    console.error('[whiteLabel] updateSetupStatus error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update status.' });
  }
}

module.exports = {
  listRequests,
  exportRequestsCsv,
  getRequestDetail,
  getPartnerGeneratedReports,
  saveBrandProfile,
  updateSetupStatus,
};
