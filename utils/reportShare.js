'use strict';
// Signed public links for AI analysis reports (Google Sheets "Report Link"
// column). Browser clicks from a sheet carry no Bearer token, so the authed
// download endpoint 401s — these capability URLs verify via HMAC instead.
//
//   <base>/api/ai-analyzer/shared/<analysisId>?exp=<unixMs>&sig=<hex>
//
// sig = HMAC-SHA256(secret, "<analysisId>.<exp>"). Links live 2 years;
// re-syncing after expiry mints fresh ones. Anyone holding the link can open
// that one report — treat the admin sheet's sharing settings accordingly.
const crypto = require('crypto');

const REPORT_LINK_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000;

function shareSecret() {
  return process.env.REPORT_LINK_SECRET || process.env.JWT_SECRET || '';
}

// Absolute signed URL for an analysis, or '' when no signing secret is
// configured (caller falls back to the authed download URL).
function signReportLink(analysisId) {
  const secret = shareSecret();
  const base = (process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
  if (!secret || !base || !analysisId) return '';
  const exp = Date.now() + REPORT_LINK_TTL_MS;
  const payload = `${analysisId}.${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${base}/api/ai-analyzer/shared/${analysisId}?exp=${exp}&sig=${sig}`;
}

function verifyReportLink(analysisId, exp, sig) {
  const secret = shareSecret();
  if (!secret || !analysisId || !exp || !sig) return false;
  if (!/^[a-f0-9]{64}$/i.test(String(sig))) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum <= Date.now()) return false;
  const payload = `${analysisId}.${expNum}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(String(sig), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { signReportLink, verifyReportLink, REPORT_LINK_TTL_MS };
