'use strict';
// ============================================================================
// chartBuilder.js — Generates fully percent-encoded quickchart.io URLs.
// Safety rules enforced here:
//   • Score gauge uses "radialGauge" (NOT "gauge")
//   • No "formatter" keys anywhere
//   • All configs are plain serialisable JSON (no JS functions)
// ============================================================================

const { formatINR } = require('./creditClassifier');
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
  let secured = stats.securedOutstanding || 0;
  let unsecured = stats.unsecuredOutstanding || 0;
  let isLifetimeView = false;

  if (!stats.hasActiveBalance) {
    if (stats.securedSanctioned > 0 || stats.unsecuredSanctioned > 0) {
      secured = stats.securedSanctioned || 0;
      unsecured = stats.unsecuredSanctioned || 0;
      isLifetimeView = true;
    } else {
      return null;
    }
  }

  // Pre-round to thousands
  const securedK = Math.round(secured / 1000);
  const unsecuredK = Math.round(unsecured / 1000);

  const config = {
    type: 'doughnut',
    data: {
      labels: ['Secured', 'Unsecured'],
      datasets: [{ data: [securedK, unsecuredK], backgroundColor: ['#4A00E0', '#8E2DE2'] }],
    },
    options: { 
      plugins: { 
        legend: { position: 'bottom' },
        datalabels: {
          color: '#fff',
          font: { weight: 'bold', size: 11 }
        }
      } 
    },
  };
  return { url: url(420, 300, config), isLifetimeView };
}

// ── 3. Risk Severity Distribution bar ───────────────────────────────────────
function riskSeverityDistributionUrl(counts) {
  // counts = { CRITICAL, HIGH, MEDIUM, LOW }
  const rawLabels = ['Critical', 'High', 'Medium', 'Low'];
  const rawData = [counts.CRITICAL || 0, counts.HIGH || 0, counts.MEDIUM || 0, counts.LOW || 0];
  const rawColors = ['#dc3545', '#fd7e14', '#ffc107', '#28a745'];

  const labels = [];
  const data = [];
  const bgColors = [];

  for (let i = 0; i < rawData.length; i++) {
    if (rawData[i] > 0) {
      labels.push(rawLabels[i]);
      data.push(rawData[i]);
      bgColors.push(rawColors[i]);
    }
  }

  if (!data.length) return null;

  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: bgColors,
      }],
    },
    options: {
      plugins: { 
        legend: { display: false },
        datalabels: {
          color: '#fff',
          font: { weight: 'bold', size: 12 }
        }
      },
      scales:  { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
    },
  };
  return url(420, 300, config);
}

// ── 4. Accounts by Type doughnut ─────────────────────────────────────────────
function accountsByTypeUrl(typeMap) {
  const PALETTE = ['#4A00E0','#8E2DE2','#6c5ce7','#a29bfe','#fd79a8','#e17055','#00b894','#00cec9','#fdcb6e','#d63031'];
  const labels = [];
  const data = [];
  const colors = [];
  let i = 0;

  for (const [key, val] of Object.entries(typeMap || {})) {
    if (val > 0) {
      labels.push(key);
      data.push(val);
      colors.push(PALETTE[i % PALETTE.length]);
    }
    i++;
  }

  if (!labels.length) return null;
  
  const config = {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors }] },
    options: { 
      plugins: { 
        legend: { position: 'right', labels: { font: { size: 10 } } },
        datalabels: {
          color: '#fff',
          font: { weight: 'bold', size: 11 }
        }
      } 
    },
  };
  return url(460, 300, config);
}

// ── 5. Accounts by Lender horizontalBar ─────────────────────────────────────
function accountsByLenderUrl(lenderMap) {
  const rawLabels = Object.keys(lenderMap || {}).slice(0, 12);
  const labels = [];
  const data = [];

  for (const l of rawLabels) {
    if (lenderMap[l] > 0) {
      labels.push(l);
      data.push(lenderMap[l]);
    }
  }

  if (!labels.length) return null;
  
  const config = {
    type: 'horizontalBar',
    data: {
      labels,
      datasets: [{ data, backgroundColor: '#8E2DE2' }],
    },
    options: {
      plugins: { 
        legend: { display: false },
        datalabels: {
          color: '#fff',
          font: { weight: 'bold', size: 11 },
          align: 'end',
          anchor: 'end'
        }
      },
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
    const sanctioned = accounts.map((a) => Math.round((a.sanctioned_amount || 0) / 1000));
    
    // Filter out rows where sanctioned is 0 too, just to be safe from empty bars
    const filteredLabels = [];
    const filteredSanctioned = [];
    for (let i = 0; i < labels.length; i++) {
        if (sanctioned[i] > 0) {
            filteredLabels.push(labels[i]);
            filteredSanctioned.push(sanctioned[i]);
        }
    }

    if (!filteredLabels.length) return null;

    const config = {
      type: 'horizontalBar',
      data: {
        labels: filteredLabels,
        datasets: [
          { label: 'Sanctioned', backgroundColor: '#4A00E0', data: filteredSanctioned },
        ],
      },
      options: {
        scales:  { x: { beginAtZero: true } },
        plugins: { 
          legend: { position: 'bottom' },
          datalabels: {
            color: '#fff',
            font: { weight: 'bold', size: 10 }
          }
        },
      },
    };
    return { url: url(560, Math.max(300, filteredLabels.length * 36 + 80), config), isLifetimeView: true };
  }

  const rawLabels    = relevant.map((a) => a.lender.substring(0, 22));
  const rawBalances  = relevant.map((a) => Math.round((a.current_balance || 0) / 1000));
  const rawSanctioned = relevant.map((a) => Math.round((a.sanctioned_amount || 0) / 1000));

  const labels = [];
  const balances = [];
  const sanctioned = [];

  for (let i = 0; i < rawLabels.length; i++) {
    if (rawBalances[i] > 0 || rawSanctioned[i] > 0) {
      labels.push(rawLabels[i]);
      balances.push(rawBalances[i]);
      sanctioned.push(rawSanctioned[i]);
    }
  }

  if (!labels.length) return null;

  const config = {
    type: 'horizontalBar',
    data: {
      labels,
      datasets: [
        { label: 'Outstanding/Loss', backgroundColor: '#dc3545', data: balances   },
        { label: 'Sanctioned',       backgroundColor: '#4A00E0', data: sanctioned },
      ],
    },
    options: {
      scales:  { x: { beginAtZero: true } },
      plugins: { 
        legend: { position: 'bottom' },
        datalabels: {
          color: '#fff',
          font: { weight: 'bold', size: 10 }
        }
      },
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
      plugins: { 
        legend: { position: 'bottom' },
        datalabels: { display: false } // Disabled for bubble chart to prevent extreme clutter
      },
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
  const rawLabels  = history.map((h) => h.month);
  const CRITICAL_TEXT_DPD_MAP = { SUB: 90, DBT: 120, LSS: 180 };
  const rawValues  = history.map((h) => {
    const v = (h.value || '').toUpperCase();
    if (v === 'OK' || v === '000') return 0;
    const n = parseInt(v, 10);
    return isNaN(n) ? (CRITICAL_TEXT_DPD_MAP[v] || 0) : n;
  });
  const rawBgColors = history.map((h) => {
    const v = parseInt(h.value, 10);
    if (isNaN(v) || v === 0) return '#28a745';
    if (v < 30)              return '#ffc107';
    if (v < 90)              return '#fd7e14';
    return '#dc3545';
  });

  const labels = [];
  const values = [];
  const bgColors = [];

  for (let i = 0; i < rawValues.length; i++) {
    if (rawValues[i] > 0) {
      labels.push(rawLabels[i]);
      values.push(rawValues[i]);
      bgColors.push(rawBgColors[i]);
    }
  }

  if (!labels.length) return null;

  // Scale width so each bar has ~20px of breathing room; floor at 620px.
  const chartWidth = Math.max(620, labels.length * 20);

  // For dense histories (>24 bars), cap the visible tick count so Chart.js
  // auto-skips labels rather than printing every one rotated at 90°.
  // autoSkip + maxTicksLimit are plain serialisable numbers — no JS function needed.
  const maxTicksLimit = labels.length > 24 ? Math.ceil(labels.length / 3) : labels.length;

  const config = {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: bgColors }] },
    options: {
      plugins: {
        legend: { display: false },
        datalabels: {
          color: '#2d3436',
          anchor: 'end',
          align: 'end',
          font: { size: 9, weight: 'bold' }
        }
      },
      scales: {
        y: { beginAtZero: true },
        x: {
          ticks: {
            font: { size: 8 },
            maxRotation: 90,
            autoSkip: true,
            maxTicksLimit
          }
        },
      },
    },
  };
  return url(chartWidth, 240, config);
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
          // Use default datalabels behavior (displayed) for this dataset
        },
        {
          label:       'Target Band',
          borderColor: '#4A00E0',
          borderDash:  [6, 4],
          fill:        false,
          data:        [target, target, target, target],
          datalabels:  { display: false } // Override to hide labels for this dataset only
        },
      ],
    },
    options: {
      plugins: { 
        legend: { position: 'bottom' },
        datalabels: {
          color: '#28a745',
          align: 'top',
          font: { weight: 'bold', size: 11 }
        }
      },
      scales:  { y: { min: minY, max: maxY } },
    },
  };
  return url(620, 300, config);
}

// ── 10. Enquiry Timeline bar chart ───────────────────────────────────────────
function enquiryTimelineUrl(enquiries, reportDateStr) {
  if (!enquiries || !enquiries.length) return null;
  
  const reportDate = new Date();
  if (reportDateStr) {
    const parts = reportDateStr.split(/[-/]/);
    if (parts.length === 3 && parts[2].length === 4) {
      reportDate.setTime(new Date(`${parts[2]}-${parts[1]}-${parts[0]}T00:00:00Z`).getTime());
    } else {
      reportDate.setTime(new Date(reportDateStr).getTime());
    }
  }
  
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const buckets = {};
  const rawLabels = [];
  
  for (let i = 23; i >= 0; i--) {
    const d = new Date(reportDate);
    d.setUTCMonth(d.getUTCMonth() - i);
    const monthKey = `${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
    buckets[monthKey] = 0;
    rawLabels.push(monthKey);
  }
  
  const twentyFourMonthsAgo = new Date(reportDate);
  twentyFourMonthsAgo.setUTCMonth(twentyFourMonthsAgo.getUTCMonth() - 23);
  twentyFourMonthsAgo.setUTCDate(1);
  twentyFourMonthsAgo.setUTCHours(0, 0, 0, 0);

  enquiries.forEach(enq => {
    if (!enq.date) return;
    let enqDate;
    const parts = enq.date.split(/[-/]/);
    if (parts.length === 3 && parts[2].length === 4) {
      enqDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}T00:00:00Z`);
    } else {
      enqDate = new Date(enq.date);
    }
    
    if (isNaN(enqDate.getTime())) return;
    
    if (enqDate >= twentyFourMonthsAgo && enqDate <= reportDate) {
      const monthKey = `${MONTHS[enqDate.getUTCMonth()]}-${enqDate.getUTCFullYear()}`;
      if (buckets.hasOwnProperty(monthKey)) {
        buckets[monthKey]++;
      }
    }
  });

  const rawData = rawLabels.map(l => buckets[l]);
  const rawBgColors = rawData.map(v => v >= 3 ? '#dc3545' : '#8E2DE2');

  const labels = [];
  const data = [];
  const bgColors = [];

  for (let i = 0; i < rawData.length; i++) {
    if (rawData[i] > 0) {
      labels.push(rawLabels[i]);
      data.push(rawData[i]);
      bgColors.push(rawBgColors[i]);
    }
  }

  if (!data.length) return null;

  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data, backgroundColor: bgColors }]
    },
    options: {
      plugins: { 
        legend: { display: false },
        datalabels: {
          color: '#2d3436',
          anchor: 'end',
          align: 'end',
          font: { size: 9, weight: 'bold' }
        }
      },
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1 } },
        x: { ticks: { font: { size: 8 }, maxRotation: 90 } },
      },
    },
  };
  return url(620, 240, config);
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
  enquiryTimelineUrl,
};
