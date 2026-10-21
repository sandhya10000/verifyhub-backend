'use strict';
// ============================================================================
// brandTheme.js -- Derives a full set of design tokens from brand colours.
//
// Input:  brand.colors = { primary, secondary, accent }  (all 6-digit hex)
// Output: theme object with computed tokens ready for EJS and chartBuilder.
//
// Safety: hex values are validated before any computation. If invalid, throws.
// Called only when brand is non-null (i.e. branded report path).
// ============================================================================

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

function mix(hex1, hex2, t) {
  const a = hexToRgb(hex1);
  const b = hexToRgb(hex2);
  return rgbToHex({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  });
}

function darken(hex, amount) { return mix(hex, '#000000', amount); }
function lighten(hex, amount) { return mix(hex, '#ffffff', amount); }

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const c = [r, g, b].map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrastText(bgHex) {
  const lum = luminance(bgHex);
  const whiteRatio = 1.05 / (lum + 0.05);
  return whiteRatio >= 4.5 ? '#ffffff' : '#1a1a2e';
}

function computeTheme(brand) {
  if (!brand || !brand.colors) throw new Error('brandTheme: brand.colors is required');
  const { primary, secondary, accent } = brand.colors;
  for (const [k, v] of Object.entries({ primary, secondary, accent })) {
    if (!v || !HEX_RE.test(v)) throw new Error('brandTheme: colors.' + k + ' must be a 6-digit hex (got: ' + v + ')');
  }

  const primaryDark   = darken(primary,   0.22);
  const secondaryDark = darken(secondary, 0.22);
  const primaryTint   = lighten(primary,  0.88);
  const primaryTint2  = lighten(primary,  0.72);
  const brandBorder   = lighten(primary,  0.60);

  const grad         = 'linear-gradient(135deg,' + primary + ' 0%,' + secondary + ' 100%)';
  const heroAccent   = 'linear-gradient(90deg,' + primary + ' 0%,' + accent + ' 55%,' + secondary + ' 100%)';
  const heroTextColor = contrastText(primary);

  const prRgb = hexToRgb(primary);
  const seRgb = hexToRgb(secondary);

  return {
    primary, secondary, accent,
    primaryDark, secondaryDark,
    primaryTint, primaryTint2, brandBorder,
    grad, heroAccent, heroTextColor,
    primaryRgba: function(a) { return 'rgba(' + prRgb.r + ',' + prRgb.g + ',' + prRgb.b + ',' + a + ')'; },
    secondaryRgba: function(a) { return 'rgba(' + seRgb.r + ',' + seRgb.g + ',' + seRgb.b + ',' + a + ')'; },
    portfolioColors: [primary, secondary],
    accentChartColor: accent,
    targetBandColor: primary,
  };
}

module.exports = { computeTheme };
