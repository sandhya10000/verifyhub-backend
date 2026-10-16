'use strict';
// Admin-only Add Funds banner (Admin → Banners tab).
// Config lives in the generic Setting doc under key "addFundsBanner":
//   { imageUrl, enabled, updatedAt }
// imageUrl is either the frontend default (/Add_Funds_banner.png, served from
// frontend public/) or an uploaded file (/uploads/banners/..., served by the
// backend static mount). Partners read it via GET /partner/pricing/plans.
const fs = require('fs');
const path = require('path');
const Setting = require('../models/Setting');
const { BANNER_UPLOAD_DIR } = require('../config/bannerUpload');

const BANNER_KEY = 'addFundsBanner';
const DEFAULT_BANNER = { imageUrl: '/Add_Funds_banner.png', enabled: true };

async function getBannerConfig() {
  const doc = await Setting.findOne({ key: BANNER_KEY }).lean();
  const stored = (doc && doc.value) || {};
  const clampCrop = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.min(0.35, Math.max(0, n));
  };
  return {
    imageUrl: typeof stored.imageUrl === 'string' && stored.imageUrl.trim()
      ? stored.imageUrl.trim()
      : DEFAULT_BANNER.imageUrl,
    enabled: stored.enabled !== false,
    // Manual crop override (fraction 0–0.35 per side). Effective crop on the
    // frontend is max(auto-detected, manual) — 0 means pure auto-detect.
    cropTop: clampCrop(stored.cropTop),
    cropBottom: clampCrop(stored.cropBottom),
    cropLeft: clampCrop(stored.cropLeft),
    cropRight: clampCrop(stored.cropRight),
    updatedAt: stored.updatedAt || (doc && doc.updatedAt) || null,
  };
}

async function saveBannerConfig(value) {
  await Setting.updateOne(
    { key: BANNER_KEY },
    { $set: { value, description: 'Add Funds banner (Admin → Banners)' } },
    { upsert: true },
  );
  return getBannerConfig();
}

// Delete a previously uploaded banner file (never touches the default).
function deleteUploadedFile(imageUrl) {
  try {
    if (!imageUrl || !imageUrl.startsWith('/uploads/banners/')) return;
    const full = path.join(BANNER_UPLOAD_DIR, path.basename(imageUrl));
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch (e) {
    console.error('[banner] old file cleanup failed:', e.message);
  }
}

// GET /api/admin/banners/add-funds
exports.getAddFundsBanner = async (req, res) => {
  try {
    const config = await getBannerConfig();
    res.json({ success: true, data: { ...config, isDefault: config.imageUrl === DEFAULT_BANNER.imageUrl } });
  } catch (err) {
    console.error('getAddFundsBanner Error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch banner' });
  }
};

// POST /api/admin/banners/add-funds (multipart, field: banner)
// Uploads a new banner image and activates it immediately.
exports.uploadAddFundsBanner = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image uploaded (field: banner)' });
    }
    const prev = await getBannerConfig();
    const imageUrl = `/uploads/banners/${req.file.filename}`;
    const config = await saveBannerConfig({
      imageUrl,
      enabled: prev.enabled,
      cropTop: prev.cropTop,
      cropBottom: prev.cropBottom,
      cropLeft: prev.cropLeft,
      cropRight: prev.cropRight,
      updatedAt: new Date().toISOString(),
    });
    deleteUploadedFile(prev.imageUrl);
    res.json({ success: true, data: { ...config, isDefault: false } });
  } catch (err) {
    console.error('uploadAddFundsBanner Error:', err);
    res.status(500).json({ success: false, message: err.message || 'Could not upload banner' });
  }
};

// PATCH /api/admin/banners/add-funds { enabled?: boolean, cropTop?: number, cropBottom?: number, cropLeft?: number, cropRight?: number }
exports.setAddFundsBannerEnabled = async (req, res) => {
  try {
    const { enabled, cropTop, cropBottom, cropLeft, cropRight } = req.body || {};
    const prev = await getBannerConfig();
    const next = { imageUrl: prev.imageUrl, enabled: prev.enabled, cropTop: prev.cropTop, cropBottom: prev.cropBottom, cropLeft: prev.cropLeft, cropRight: prev.cropRight };
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, message: 'enabled (boolean) is required' });
      }
      next.enabled = enabled;
    }
    for (const [key, val] of [['cropTop', cropTop], ['cropBottom', cropBottom], ['cropLeft', cropLeft], ['cropRight', cropRight]]) {
      if (val !== undefined) {
        const n = Number(val);
        if (!Number.isFinite(n) || n < 0 || n > 0.35) {
          return res.status(400).json({ success: false, message: `${key} must be between 0 and 0.35` });
        }
        next[key] = n;
      }
    }
    next.updatedAt = new Date().toISOString();
    const config = await saveBannerConfig(next);
    res.json({ success: true, data: { ...config, isDefault: config.imageUrl === DEFAULT_BANNER.imageUrl } });
  } catch (err) {
    console.error('setAddFundsBannerEnabled Error:', err);
    res.status(500).json({ success: false, message: 'Could not update banner' });
  }
};

// DELETE /api/admin/banners/add-funds — revert to the default banner.
exports.resetAddFundsBanner = async (req, res) => {
  try {
    const prev = await getBannerConfig();
    const config = await saveBannerConfig({
      imageUrl: DEFAULT_BANNER.imageUrl,
      enabled: true,
      cropTop: 0,
      cropBottom: 0,
      cropLeft: 0,
      cropRight: 0,
      updatedAt: new Date().toISOString(),
    });
    deleteUploadedFile(prev.imageUrl);
    res.json({ success: true, data: { ...config, isDefault: true } });
  } catch (err) {
    console.error('resetAddFundsBanner Error:', err);
    res.status(500).json({ success: false, message: 'Could not reset banner' });
  }
};

module.exports.getBannerConfig = getBannerConfig;
module.exports.DEFAULT_BANNER = DEFAULT_BANNER;
