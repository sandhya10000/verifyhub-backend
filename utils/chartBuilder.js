'use strict';
// ============================================================================
// chartBuilder.js — Generates fully percent-encoded quickchart.io URLs.
// Safety rules enforced here:
//   • Score gauge uses "radialGauge" (NOT "gauge")
//   • No "formatter" keys anywhere
//   • All configs are plain serialisable JSON (no JS functions)
// ============================================================================

const BASE = 'https://quickchart.io/chart';

function url(w, h, config) {
  return `${BASE}?w=${w}&h=${h}&bkg=white&c=${encodeURIComponent(JSON.stringify(config))}`;
}

// ── Score color helper ───────────────────────────────────────────────────────
function scoreColor(score) {
  if (score >= 750) return '#28a745';
  if (score >= 700) return '#ffc107';
  return '#dc3545';
}

// ── 1. Score radialGauge ────────────────────────────────────────────────────
function scoreGaugeUrl(score) {
  const color  = scoreColor(score);
  const config = {
    type: 'radialGauge',
    data: { datasets: [{ data: [score], backgroundColor: color }] },
    options: {
      domain:           [300, 900],
      trackColor:       '#e9ecef',
      roundedCorners:   true,
      centerPercentage: 78,
      centerArea: { text: String(score), fontSize: 46, fontColor: '#2d3436' },
    },
  };
  return url(420, 260, config);
}

// ── 2. Portfolio Mix doughnut ────────────────────────────────────────────────
function portfolioMixUrl(stats) {
  let secured = stats.securedOutstanding;
  let unsecured = stats.unsecuredOutstanding;
  let isLifetimeView = false;

  if (!stats.hasActiveBalance) {
    if (stats.securedSanctioned > 0 || stats.unsecuredSanctioned > 0) {
      secured = stats.securedSanctioned;
      unsecured = stats.unsecuredSanctioned;
      isLifetimeView = true;
    } else {
      return null;
    }
  }

  const config = {
    type: 'doughnut',
    data: {
      labels: ['Secured', 'Unsecured'],
      datasets: [{ data: [secured, unsecured], backgroundColor: ['#4A00E0', '#8E2DE2'] }],
    },
    options: { plugins: { legend: { position: 'bottom' } } },
  };
  return { url: url(420, 300, config), isLifetimeView };
}

// ── 3. Risk Severity Distribution bar ───────────────────────────────────────
function riskSeverityDistributionUrl(counts) {
  // counts = { CRITICAL, HIGH, MEDIUM, LOW }
  const config = {
    type: 'bar',
    data: {
      labels: ['Critical', 'High', 'Medium', 'Low'],
      datasets: [{
        data:            [counts.CRITICAL || 0, counts.HIGH || 0, counts.MEDIUM || 0, counts.LOW || 0],
        backgroundColor: ['#dc3545', '#fd7e14', '#ffc107', '#28a745'],
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales:  { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
    },
  };
  return url(420, 300, config);
}

// ── 4. Accounts by Type doughnut ─────────────────────────────────────────────
function accountsByTypeUrl(typeMap) {
  const labels  = Object.keys(typeMap || {});
  if (!labels.length) return null;
  const PALETTE = ['#4A00E0','#8E2DE2','#6c5ce7','#a29bfe','#fd79a8','#e17055','#00b894','#00cec9','#fdcb6e','#d63031'];
  const data    = Object.values(typeMap);
  const colors  = labels.map((_, i) => PALETTE[i % PALETTE.length]);
  const config = {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors }] },
    options: { plugins: { legend: { position: 'right', labels: { font: { size: 10 } } } } },
  };
  return url(460, 300, config);
}

// ── 5. Accounts by Lender horizontalBar ─────────────────────────────────────
function accountsByLenderUrl(lenderMap) {
  const labels = Object.keys(lenderMap || {}).slice(0, 12);
  if (!labels.length) return null;
  const data   = labels.map((l) => lenderMap[l]);
  const config = {
    type: 'horizontalBar',
    data: {
      labels,
      datasets: [{ data, backgroundColor: '#8E2DE2' }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales:  { x: { beginAtZero: true, ticks: { stepSize: 1 } } },
    },
  };
  return url(460, Math.max(300, labels.length * 32 + 60), config);
}

// ── 6. Outstanding/Loss vs Sanctioned horizontalBar ─────────────────────────
function outstandingVsSanctionedUrl(accounts) {
  accounts = accounts || [];
  if (accounts.length === 0) return null;

  const relevant = accounts.filter(
    (a) => (a.current_balance || 0) > 0 || (a.written_off_amount || 0) > 0
  );

  if (!relevant.length) {
    const labels = accounts.map((a) => a.lender.substring(0, 22));
    const sanctioned = accounts.map((a) => a.sanctioned_amount || 0);
    const config = {
      type: 'horizontalBar',
      data: {
        labels,
        datasets: [
          { label: 'Sanctioned', backgroundColor: '#4A00E0', data: sanctioned },
        ],
      },
      options: {
        scales:  { x: { beginAtZero: true } },
        plugins: { legend: { position: 'bottom' } },
      },
    };
    return { url: url(560, Math.max(300, labels.length * 36 + 80), config), isLifetimeView: true };
  }

  const labels    = relevant.map((a) => a.lender.substring(0, 22));
  const balances  = relevant.map((a) => a.current_balance    || 0);
  const sanctioned = relevant.map((a) => a.sanctioned_amount || 0);
  const config = {
    type: 'horizontalBar',
    data: {
      labels,
      datasets: [
        { label: 'Outstanding/Written-off', backgroundColor: '#dc3545', data: balances   },
        { label: 'Sanctioned',              backgroundColor: '#4A00E0', data: sanctioned },
      ],
    },
    options: {
      scales:  { x: { beginAtZero: true } },
      plugins: { legend: { position: 'bottom' } },
    },
  };
  return { url: url(560, Math.max(300, labels.length * 36 + 80), config), isLifetimeView: false };
}

// ── 7. Risk Map bubble chart ─────────────────────────────────────────────────
function riskMapUrl(annotatedAccounts) {
  const SEVERITY_PAIRS = [
    ['CRITICAL', '#dc3545'],
    ['HIGH',     '#fd7e14'],
    ['MEDIUM',   '#ffc107'],
    ['LOW',      '#28a745'],
  ];
  const datasets = [];
  for (const [sev, color] of SEVERITY_PAIRS) {
    const accts = annotatedAccounts.filter((a) => a._severity === sev);
    if (!accts.length) continue;
    datasets.push({
      label:           sev.charAt(0) + sev.slice(1).toLowerCase(),
      backgroundColor: color,
      data: accts.map((a) => ({
        x: a.max_dpd || 0,
        y: a._healthScore,
        r: Math.max(5, Math.min(25, Math.round(((a.current_balance || 0) + (a.written_off_amount || 0)) / 50000))),
      })),
    });
  }
  if (!datasets.length) {
    datasets.push({ label: 'No data', data: [{ x: 0, y: 100, r: 5 }], backgroundColor: '#28a745' });
  }
  const config = {
    type: 'bubble',
    data: { datasets },
    options: {
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { title: { display: true, text: 'Max DPD (days)' }, beginAtZero: true },
        y: { title: { display: true, text: 'Account Health (0-100)' }, min: 0, max: 105 },
      },
    },
  };
  return url(560, 360, config);
}

// ── 8. Per-account DPD history bar ──────────────────────────────────────────
// Only call for accounts where max_dpd > 0.
function dpdHistoryBarUrl(acct) {
  const history = [...(acct.dpd_history || [])].reverse(); // chronological
  const labels  = history.map((h) => h.month);
  const CRITICAL_TEXT_DPD_MAP = { SUB: 90, DBT: 120, LSS: 180 };
  const values  = history.map((h) => {
    const v = (h.value || '').toUpperCase();
    if (v === 'OK' || v === '000') return 0;
    const n = parseInt(v, 10);
    return isNaN(n) ? (CRITICAL_TEXT_DPD_MAP[v] || 0) : n;
  });
  const bgColors = history.map((h) => {
    const v = parseInt(h.value, 10);
    if (isNaN(v) || v === 0) return '#28a745';
    if (v < 30)              return '#ffc107';
    if (v < 90)              return '#fd7e14';
    return '#dc3545';
  });
  const config = {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: bgColors }] },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true },
        x: { ticks: { font: { size: 8 }, maxRotation: 90 } },
      },
    },
  };
  return url(620, 240, config);
}

// ── 9. Projected Score Trajectory line chart ─────────────────────────────────
function projectedScoreUrl(projectedScores) {
  const scores = Array.isArray(projectedScores) && projectedScores.length === 4
    ? projectedScores
    : [projectedScores[0] || 600, projectedScores[0] || 610, projectedScores[0] || 620, projectedScores[0] || 630];
  const minY   = Math.max(300, Math.min(...scores) - 30);
  const maxY   = Math.min(900, Math.max(...scores) + 30);
  const target = Math.min(900, scores[0] + 50);
  const config = {
    type: 'line',
    data: {
      labels: ['Now', 'Month 1', 'Month 2', 'Month 3'],
      datasets: [
        {
          label:           'Projected Score',
          borderColor:     '#28a745',
          backgroundColor: 'rgba(40,167,69,.15)',
          fill:            true,
          tension:         0.3,
          data:            scores,
        },
        {
          label:       'Target Band',
          borderColor: '#4A00E0',
          borderDash:  [6, 4],
          fill:        false,
          data:        [target, target, target, target],
        },
      ],
    },
    options: {
      plugins: { legend: { position: 'bottom' } },
      scales:  { y: { min: minY, max: maxY } },
    },
  };
  return url(620, 300, config);
}

module.exports = {
  scoreGaugeUrl,
  scoreColor,
  portfolioMixUrl,
  riskSeverityDistributionUrl,
  accountsByTypeUrl,
  accountsByLenderUrl,
  outstandingVsSanctionedUrl,
  riskMapUrl,
  dpdHistoryBarUrl,
  projectedScoreUrl,
};
