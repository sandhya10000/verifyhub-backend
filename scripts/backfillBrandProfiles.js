'use strict';
// =============================================================================
// scripts/backfillBrandProfiles.js
//
// Backfills a BrandProfile document for every partner who has paid for
// AI Custom Branded Reports but whose brandprofiles collection entry is
// missing.  Safe to run repeatedly — it checks for an existing active profile
// before inserting and never deletes or overwrites existing records.
//
// Usage (standalone):
//   node scripts/backfillBrandProfiles.js
//
// When imported from Server.js it is called as backfillBrandProfiles() after
// the Mongoose connection is open.
// =============================================================================

const mongoose = require('mongoose');
const https    = require('https');
const http     = require('http');

// ---------------------------------------------------------------------------
// Lazy-load models so the script works both standalone (after dotenv + connect)
// and when required from the already-booted server process.
// ---------------------------------------------------------------------------
function getModels() {
  const User                 = require('../models/User');
  const BrandProfile         = require('../models/BrandProfile');
  const CustomBrandedRequest = require('../models/CustomBrandedRequest');
  return { User, BrandProfile, CustomBrandedRequest };
}

// ---------------------------------------------------------------------------
// Default safe hex colors that satisfy validateBrand()
// ---------------------------------------------------------------------------
const DEFAULT_COLORS = {
  primary:   '#1A3C5E',
  secondary: '#2E86AB',
  accent:    '#F5A623',
};

// ---------------------------------------------------------------------------
// A 1x1 transparent PNG as a base64 data URI.
// validateBrand() checks that the string starts with "data:image/png;base64,"
// and does not decode or check dimensions.
// width/height are set to 1 to satisfy the schema's required Number fields.
// ---------------------------------------------------------------------------
const FALLBACK_LOGO = {
  dataUri:  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  mimeType: 'image/png',
  width:    1,
  height:   1,
};

// ---------------------------------------------------------------------------
// fetchImageAsDataUri
// Downloads a URL and returns { dataUri, mimeType, width, height }.
// Returns null on any failure; caller falls back to FALLBACK_LOGO.
// validateBrand() only checks the data URI prefix (not pixel dimensions),
// so we set width/height to 0 when we cannot decode them.
// ---------------------------------------------------------------------------
function fetchImageAsDataUri(url) {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const req = transport.get(url, { timeout: 10000 }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume(); // drain the socket
          return resolve(null);
        }

        const contentType = (res.headers['content-type'] || '').split(';')[0].trim();
        // validateBrand() only accepts these two prefixes
        if (contentType !== 'image/png' && contentType !== 'image/jpeg') {
          res.resume();
          return resolve(null);
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (!buf.length) return resolve(null);
          const dataUri = `data:${contentType};base64,${buf.toString('base64')}`;
          resolve({ dataUri, mimeType: contentType, width: 0, height: 0 });
        });
        res.on('error', () => resolve(null));
      });

      req.on('error',   () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch (_) {
      resolve(null);
    }
  });
}

// ---------------------------------------------------------------------------
// mapColors
// Converts a brandColors string array to { primary, secondary, accent }.
// Filters out invalid hex values and fills missing slots with defaults.
// ---------------------------------------------------------------------------
function mapColors(brandColors) {
  const hexRe = /^#[0-9A-Fa-f]{6}$/;
  const safe  = Array.isArray(brandColors)
    ? brandColors.filter((c) => hexRe.test(c))
    : [];

  return {
    primary:   safe[0] || DEFAULT_COLORS.primary,
    secondary: safe[1] || DEFAULT_COLORS.secondary,
    accent:    safe[2] || DEFAULT_COLORS.accent,
  };
}

// ---------------------------------------------------------------------------
// backfillBrandProfiles — exported async function.
// Uses the already-open Mongoose connection and env vars; no args required.
// ---------------------------------------------------------------------------
async function backfillBrandProfiles() {
  const { User, BrandProfile, CustomBrandedRequest } = getModels();

  // Website field is required and must start with https://.
  // Default to the platform domain; override via env for white-label deploys.
  const WEBSITE_FALLBACK = process.env.BRAND_WEBSITE_FALLBACK || 'https://verifyhub.in';

  console.log('[backfillBrandProfiles] Starting scan…');

  // ── 1. Find all partners who should have a brand profile ────────────────
  const candidates = await User.find({
    brandingStatus: { $in: ['paid', 'onboarding', 'active'] },
  })
    .select('_id partner_id name email phone brandingStatus brandingDetails')
    .lean();

  console.log(`[backfillBrandProfiles] Found ${candidates.length} candidate partner(s).`);

  const stats = {
    scanned: candidates.length,
    created: 0,
    skipped: 0,
    failed:  [],
  };

  for (const user of candidates) {
    try {
      // ── 2. Idempotency check — skip if an active profile already exists ──
      const existing = await BrandProfile.findOne({
        partnerId: user._id,
        isActive:  true,
      }).lean();

      if (existing) {
        stats.skipped++;
        continue;
      }

      // ── 3. Resolve brandingDetails (user first, then latest paid CBR) ────
      let details = user.brandingDetails || {};
      const hasUserDetails =
        (details.companyName && String(details.companyName).trim()) ||
        (details.logoUrl     && String(details.logoUrl).trim())     ||
        (Array.isArray(details.brandColors) && details.brandColors.length);

      if (!hasUserDetails) {
        const latestCbr = await CustomBrandedRequest.findOne({
          partnerId:     user._id,
          paymentStatus: 'Paid',
        })
          .sort({ updatedAt: -1 })
          .select('brandingDetails')
          .lean();

        if (latestCbr && latestCbr.brandingDetails) {
          details = latestCbr.brandingDetails;
        }
      }

      // ── 4. firmName ──────────────────────────────────────────────────────
      const firmName =
        (details.companyName && String(details.companyName).trim()) ||
        String(user.name).trim();

      // ── 5. tagline ───────────────────────────────────────────────────────
      const tagline = (details.tagline && String(details.tagline).trim()) || '';

      // ── 6. colors ────────────────────────────────────────────────────────
      const colors = mapColors(details.brandColors);

      // ── 7. logo ──────────────────────────────────────────────────────────
      let logo      = null;
      const logoUrl = details.logoUrl && String(details.logoUrl).trim();

      if (logoUrl) {
        logo = await fetchImageAsDataUri(logoUrl);
        if (!logo) {
          console.warn(
            `[backfillBrandProfiles] WARNING — could not fetch logo for user ${user._id}` +
            ` (url: ${logoUrl}). Using fallback placeholder.`,
          );
        }
      }

      if (!logo) {
        // Safe 1x1 PNG placeholder. resolveBrandLogo() will override this at
        // render time if a real file is placed in brand-assets/<partnerCode>/.
        logo = { ...FALLBACK_LOGO };
      }

      // ── 8. partnerCode — User.partner_id ("VH001"), else ObjectId string ─
      const partnerCode = (user.partner_id
        ? String(user.partner_id)
        : String(user._id)
      ).toLowerCase();

      // ── 9. Required contact fields ───────────────────────────────────────
      const email   = String(user.email  || '').trim().toLowerCase();
      const phone   = String(details.contactPhone || user.phone || '').trim();
      const website = WEBSITE_FALLBACK;

      // ── 10. Insert the profile ───────────────────────────────────────────
      await BrandProfile.create({
        partnerId:   user._id,
        partnerCode,
        firmName,
        tagline,
        logo,
        colors,
        email,
        website,
        phone,
        version:  1,
        isActive: true,
      });

      stats.created++;
      console.log(
        `[backfillBrandProfiles] Created BrandProfile for user ${user._id}` +
        ` (partnerCode="${partnerCode}", firmName="${firmName}").`,
      );

      // ── 11. Promote brandingStatus to 'active' ───────────────────────────
      // uploadBrandedReport gate requires brandingStatus === 'active', so any
      // partner stuck at 'paid' or 'onboarding' is promoted now that they
      // have a valid profile.
      if (user.brandingStatus === 'paid' || user.brandingStatus === 'onboarding') {
        await User.updateOne(
          { _id: user._id },
          { $set: { brandingStatus: 'active' } },
        );
        console.log(
          `[backfillBrandProfiles] Promoted brandingStatus to 'active' for user ${user._id}` +
          ` (was '${user.brandingStatus}').`,
        );
      }
    } catch (err) {
      // One user failure never stops the rest.
      stats.failed.push(String(user._id));
      console.error(
        `[backfillBrandProfiles] FAILED for user ${user._id}:`,
        err.message,
      );
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(
    `[backfillBrandProfiles] Done —` +
    ` scanned=${stats.scanned}` +
    ` created=${stats.created}` +
    ` skipped=${stats.skipped}` +
    ` failed=${stats.failed.length}` +
    (stats.failed.length ? ` (user ids: ${stats.failed.join(', ')})` : ''),
  );
}

// ---------------------------------------------------------------------------
// Standalone entry-point — only executes when run directly:
//   node scripts/backfillBrandProfiles.js
// When imported by Server.js the exported function is called instead.
// ---------------------------------------------------------------------------
if (require.main === module) {
  require('dotenv').config();
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('[backfillBrandProfiles] MONGO_URI / MONGODB_URI is not set in .env');
    process.exit(1);
  }
  mongoose
    .connect(uri)
    .then(() => backfillBrandProfiles())
    .then(() => mongoose.disconnect())
    .catch((err) => {
      console.error('[backfillBrandProfiles] Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { backfillBrandProfiles };
