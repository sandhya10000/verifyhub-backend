'use strict';
// ============================================================================
// reportRenderer.js — Orchestrates classification, chart building, and
// EJS template rendering from a single structured data object.
// Called synchronously after the Claude extraction tool call completes.
// Expected time: 5-20ms (all pure JS + URL string building, no I/O).
// ============================================================================
const ejs  = require('ejs');
const path = require('path');
const fs = require('fs');

const {
  annotateAccounts,
  computePortfolioStats,
  computeProfileNote,
  addSeverityToRiskFactors,
  rerankRiskFactors,
  dpdCodeToColor,
  formatINR,
  computeEnquiryCounts,
} = require('./creditClassifier');

const charts = require('./chartBuilder');
const { LOGO_DATA_URI } = require('./brandAssets');

const TEMPLATE_PATH = path.join(__dirname, '../views/creditReport.ejs');

// ── Load locales ─────────────────────────────────────────────────────────────
const locales = {};
try {
  const localeFiles = fs.readdirSync(path.join(__dirname, '../locales'));
  for (const file of localeFiles) {
    if (file.endsWith('.json')) {
      const code = file.replace('.json', '');
      locales[code] = JSON.parse(fs.readFileSync(path.join(__dirname, '../locales', file), 'utf-8'));
    }
  }
} catch (e) {
  console.warn('Failed to load locales:', e.message);
}

/**
 * getTranslator — returns t(key, vars) that falls back to en if key missing.
 * Nested keys are supported with dot-notation (e.g. "months.jan").
 */
function getTranslator(lang) {
  const dict   = locales[lang]   || locales['en'] || {};
  const enDict = locales['en']   || {};

  return function t(key, vars = {}) {
    // Support dot-notation for nested keys (e.g. "months.jan")
    function resolve(obj, k) {
      const parts = k.split('.');
      let cur = obj;
      for (const p of parts) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[p];
      }
      return (typeof cur === 'string') ? cur : undefined;
    }

    let str = resolve(dict, key);
    if (str === undefined) {
      if (lang !== 'en') {
        console.warn(`[Locale Warning] Missing key '${key}' in locale '${lang}'. Falling back to English.`);
      }
      str = resolve(enDict, key);
    }
    if (str === undefined) return key; // last-resort: return the key itself

    // Interpolation: replace {varName} with vars.varName
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    }
    return str;
  };
}

// ── Value maps for translating bureau enum strings ───────────────────────────
const ACCOUNT_TYPE_MAP = {
  'Used Car Loan':                    'account_type_used_car_loan',
  'Gold Loan':                        'account_type_gold_loan',
  'Overdraft':                        'account_type_overdraft',
  'Business Loan - Unsecured':        'account_type_business_loan_unsecured',
  'Business Loan - General':          'account_type_business_loan_general',
  'Commercial Vehicle Loan':          'account_type_commercial_vehicle_loan',
  'Personal Loan':                    'account_type_personal_loan',
  'Auto Loan Personal':               'account_type_auto_loan_personal',
  'Credit Card':                      'account_type_credit_card',
  'Home Loan':                        'account_type_home_loan',
  'Loan Against Property':            'account_type_loan_against_property',
  'Two Wheeler Loan':                 'account_type_two_wheeler_loan',
  'Consumer Loan':                    'account_type_consumer_loan',
  'Education Loan':                   'account_type_education_loan',
  'Agriculture Loan':                 'account_type_agriculture_loan',
  'Microfinance':                     'account_type_microfinance',
  'Kisan Credit Card':                'account_type_kisan_credit_card',
  'Secured Credit Card':              'account_type_secured_credit_card',
  'Loan on Credit Card':              'account_type_loan_on_credit_card',
  'Staff Loan':                       'account_type_staff_loan',
  'Fleet Loan':                       'account_type_fleet_loan',
  'Property Loan':                    'account_type_property_loan',
};

const ENQUIRY_PURPOSE_MAP = {
  'Used Car Loan':                    'purpose_used_car_loan',
  'Gold Loan':                        'purpose_gold_loan',
  'Overdraft':                        'purpose_overdraft',
  'Business Loan - Unsecured':        'purpose_business_loan_unsecured',
  'Business Loan - General':          'purpose_business_loan_general',
  'Commercial Vehicle Loan':          'purpose_commercial_vehicle_loan',
  'Personal Loan':                    'purpose_personal_loan',
  'Auto Loan Personal':               'purpose_auto_loan_personal',
  'Credit Card':                      'purpose_credit_card',
  'Home Loan':                        'purpose_home_loan',
  'Loan Against Property':            'purpose_loan_against_property',
  'Two Wheeler Loan':                 'purpose_two_wheeler_loan',
  'Consumer Loan':                    'purpose_consumer_loan',
  'Education Loan':                   'purpose_education_loan',
  'Agriculture Loan':                 'purpose_agriculture_loan',
  'Microfinance':                     'purpose_microfinance',
};

const SEVERITY_MAP = {
  CRITICAL: 'severity_critical',
  HIGH:     'severity_high',
  MEDIUM:   'severity_medium',
  LOW:      'severity_low',
  // mr
  'गंभीर': 'severity_critical',
  'उच्च': 'severity_high',
  'मध्यम': 'severity_medium',
  'कमी': 'severity_low',

  // gu
  'ગંભીર': 'severity_critical',
  'ઉચ્ચ': 'severity_high',
  'મધ્યમ': 'severity_medium',
  'ઓછું': 'severity_low',

  // ta
  'மிகவும் ஆபத்தானது': 'severity_critical',
  'அதிகம்': 'severity_high',
  'நடுத்தரம்': 'severity_medium',
  'குறைவு': 'severity_low',

  // te
  'క్లిష్టమైనది': 'severity_critical',
  'అధికం': 'severity_high',
  'మధ్యస్థం': 'severity_medium',
  'తక్కువ': 'severity_low',

  // kn
  'ಗಂಭೀರ': 'severity_critical',
  'ಹೆಚ್ಚು': 'severity_high',
  'ಮಧ್ಯಮ': 'severity_medium',
  'ಕಡಿಮೆ': 'severity_low',

  // bn
  'সংকটপূর্ণ': 'severity_critical',
  'উচ্চ': 'severity_high',
  'মাঝারি': 'severity_medium',
  'নিম্ন': 'severity_low',

  // hi
  'गंभीर': 'severity_critical',
  'उच्च': 'severity_high',
  'मध्यम': 'severity_medium',
  'कम': 'severity_low',
};

const STATUS_MAP = {
  Active:  'status_active',
  Closed:  'status_closed',
  ACTIVE:  'status_active',
  CLOSED:  'status_closed',
  // mr
  'सक्रिय': 'status_active',
  'बंद': 'status_closed',

  // gu
  'સક્રિય': 'status_active',
  'બંધ': 'status_closed',

  // ta
  'செயலில் உள்ளது': 'status_active',
  'மூடப்பட்டது': 'status_closed',

  // te
  'సక్రియంగా ఉంది': 'status_active',
  'మూసివేయబడింది': 'status_closed',

  // kn
  'ಸಕ್ರಿಯ': 'status_active',
  'ಮುಚ್ಚಲಾಗಿದೆ': 'status_closed',

  // bn
  'সক্রিয়': 'status_active',
  'বন্ধ': 'status_closed',

  // hi
  'सक्रिय': 'status_active',
  'बंद': 'status_closed',
};

const OWNERSHIP_MAP = {
  Individual: 'ownership_individual',
  Joint:      'ownership_joint',
  Guarantor:  'ownership_guarantor',
  INDIVIDUAL: 'ownership_individual',
  JOINT:      'ownership_joint',
  GUARANTOR:  'ownership_guarantor',
  // mr
  'वैयक्तिक': 'ownership_individual',
  'संयुक्त': 'ownership_joint',
  'जामीनदार': 'ownership_guarantor',

  // gu
  'વ્યક્તિગત': 'ownership_individual',
  'સંયુક્ત': 'ownership_joint',
  'જામીનદાર': 'ownership_guarantor',

  // ta
  'தனிநபர்': 'ownership_individual',
  'கூட்டு': 'ownership_joint',
  'உத்தரவாதமளிப்பவர்': 'ownership_guarantor',

  // te
  'వ్యక్తిగతం': 'ownership_individual',
  'ఉమ్మడి': 'ownership_joint',
  'గ్యారంటర్': 'ownership_guarantor',

  // kn
  'ವೈಯಕ್ತಿಕ': 'ownership_individual',
  'ಜಂಟಿ': 'ownership_joint',
  'ಖಾತರಿದಾರ': 'ownership_guarantor',

  // bn
  'ব্যক্তিগত': 'ownership_individual',
  'যৌথ': 'ownership_joint',
  'গ্যারান্টার': 'ownership_guarantor',

  // hi
  'व्यक्तिगत': 'ownership_individual',
  'संयुक्त': 'ownership_joint',
  'गारंटर': 'ownership_guarantor',
};

const SCORE_BAND_MAP = {
  'Excellent':     'band_excellent',
  'Good':          'band_good',
  'Fair':          'band_fair',
  'Poor':          'band_poor',
  'Below Average': 'band_below_average',
  'Very Poor':     'band_very_poor',
  'No History':    'band_no_history',
  // mr
  'उत्कृष्ट': 'band_excellent',
  'चांगला': 'band_good',
  'वाजवी': 'band_fair',
  'खराब': 'band_poor',
  'सरासरीपेक्षा कमी': 'band_below_average',
  'अतिशय खराब': 'band_very_poor',
  'इतिहास नाही': 'band_no_history',

  // gu
  'ઉત્કૃષ્ટ': 'band_excellent',
  'સારું': 'band_good',
  'વાજબી': 'band_fair',
  'નબળું': 'band_poor',
  'સરેરાશથી નીચે': 'band_below_average',
  'ખૂબ નબળું': 'band_very_poor',
  'કોઈ ઇતિહાસ નથી': 'band_no_history',

  // ta
  'சிறப்பானது': 'band_excellent',
  'நல்லது': 'band_good',
  'சுமாரானது': 'band_fair',
  'மோசமானது': 'band_poor',
  'சராசரிக்கும் கீழே': 'band_below_average',
  'மிகவும் மோசமானது': 'band_very_poor',
  'வரலாறு இல்லை': 'band_no_history',

  // te
  'అద్భుతమైనది': 'band_excellent',
  'మంచిది': 'band_good',
  'సగటు': 'band_fair',
  'తక్కువ': 'band_poor',
  'సగటు కంటే తక్కువ': 'band_below_average',
  'చాలా తక్కువ': 'band_very_poor',
  'చరిత్ర లేదు': 'band_no_history',

  // kn
  'ಅತ್ಯುತ್ತಮ': 'band_excellent',
  'ಉತ್ತಮ': 'band_good',
  'ಸಾಧಾರಣ': 'band_fair',
  'ಕಳಪೆ': 'band_poor',
  'ಸರಾಸರಿಗಿಂತ ಕಡಿಮೆ': 'band_below_average',
  'ತುಂಬಾ ಕಳಪೆ': 'band_very_poor',
  'ಯಾವುದೇ ಇತಿಹಾಸವಿಲ್ಲ': 'band_no_history',

  // bn
  'চমৎকার': 'band_excellent',
  'ভালো': 'band_good',
  'মোটামুটি': 'band_fair',
  'খারাপ': 'band_poor',
  'গড়ের নিচে': 'band_below_average',
  'খুব খারাপ': 'band_very_poor',
  'কোনো ইতিহাস নেই': 'band_no_history',

  // hi
  'उत्कृष्ट': 'band_excellent',
  'अच्छा': 'band_good',
  'औसत': 'band_fair',
  'खराब': 'band_poor',
  'औसत से नीचे': 'band_below_average',
  'बहुत खराब': 'band_very_poor',
  'कोई इतिहास नहीं': 'band_no_history',
};

/**
 * Format a month label (e.g. "Sep-2026") using Intl with Latin digits.
 * Keeps hyphens, returns the original string on parse failure.
 */
function formatMonthLabel(raw, langCode) {
  if (!raw) return raw;
  // raw is expected to be like "Sep-2026"
  try {
    const [mon, year] = raw.split('-');
    const MONTHS_EN = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const idx = MONTHS_EN.indexOf(mon.toLowerCase().slice(0, 3));
    if (idx === -1 || !year) return raw;
    const d = new Date(parseInt(year, 10), idx, 1);
    // Use Intl with latn extension so digits are always ASCII
    return new Intl.DateTimeFormat(`${langCode}-u-nu-latn`, { month: 'short', year: 'numeric' }).format(d);
  } catch {
    return raw;
  }
}

/**
 * renderCreditReport
 * @param {object} data — raw output from the expanded ANALYSIS_TOOL
 * @returns {Promise<string>} — complete, self-contained HTML string
 */
async function renderCreditReport(data) {
  const lang = data.language || 'en';
  const t    = getTranslator(lang);
  const isRTL = lang === 'ur';

  // ── Value translators ──────────────────────────────────────────────────────
  function tSeverity(raw) {
    const key = SEVERITY_MAP[raw];
    return key ? t(key) : (raw || '—');
  }

  function tStatus(raw) {
    const key = STATUS_MAP[raw];
    return key ? t(key) : (raw || '—');
  }

  function tOwnership(raw) {
    const key = OWNERSHIP_MAP[raw];
    return key ? t(key) : (raw || '—');
  }

  function tAccountType(raw) {
    const key = ACCOUNT_TYPE_MAP[raw];
    return key ? t(key) : (raw || '—');
  }

  function tEnquiryPurpose(raw) {
    const key = ENQUIRY_PURPOSE_MAP[raw];
    return key ? t(key) : (raw || '—');
  }

  function tScoreBand(raw) {
    const key = SCORE_BAND_MAP[raw];
    return key ? t(key) : (raw || '—');
  }

  function tMonthLabel(raw) {
    return lang === 'en' ? raw : formatMonthLabel(raw, lang);
  }

  // ── 1. Annotate accounts with deterministic classification ────────────────
  const accounts = annotateAccounts(data.accounts || []);

  // ── 2. Portfolio-level aggregates ─────────────────────────────────────────
  const stats = computePortfolioStats(accounts);

  // ── 3. Profile note ───────────────────────────────────────────────────────
  const profileNote = computeProfileNote(stats);

  // ── 4. Deterministic enquiry counts ──────────────────────────────────────
  const enquiryCounts = computeEnquiryCounts(
    data.enquiries || [],
    data.report_date || null
  );

  // ── 5. Risk factors with severity + re-ranking ───────────────────────────
  const riskFactorsWithSeverity = addSeverityToRiskFactors(data.risk_factors || [], accounts);
  const riskFactors = rerankRiskFactors(riskFactorsWithSeverity, accounts, enquiryCounts);

  // ── 6. Build translated chart labels ─────────────────────────────────────
  const chartLabels = {
    secured:           t('chart_secured'),
    unsecured:         t('chart_unsecured'),
    critical:          t('chart_critical'),
    high:              t('chart_high'),
    medium:            t('chart_medium'),
    low:               t('chart_low'),
    outstanding:       t('chart_outstanding'),
    sanctioned:        t('chart_sanctioned'),
    projectedScore:    t('chart_projected_score'),
    targetBand:        t('chart_target_band'),
    now:               t('chart_now'),
    month1:            t('chart_month_1'),
    month2:            t('chart_month_2'),
    month3:            t('chart_month_3'),
    maxDpd:            t('chart_axis_max_dpd'),
    accountHealth:     t('chart_axis_account_health'),
    noData:            t('chart_no_data'),
  };

  // ── 7. Build all chart URLs (now with translated labels) ──────────────────
  const score = data.credit_score || 0;
  const projectedScores = Array.isArray(data.projected_scores) && data.projected_scores.length === 4
    ? data.projected_scores
    : [score, score + 10, score + 20, score + 30];

  const dpdCharts = {};
  for (const acct of accounts) {
    if ((acct.max_dpd || 0) > 0 && (acct.dpd_history || []).length > 0) {
      // Translate month labels for per-account DPD bar
      const acctForChart = {
        ...acct,
        dpd_history: acct.dpd_history.map(h => ({ ...h, month: tMonthLabel(h.month) })),
      };
      dpdCharts[acct.masked_account_number] = charts.dpdHistoryBarUrl(acctForChart);
    }
  }

  const chartUrls = {
    scoreGauge:         charts.scoreGaugeUrl(score),
    portfolioMix:       charts.portfolioMixUrl(stats, chartLabels),
    riskSeverity:       charts.riskSeverityDistributionUrl(stats.severityCounts, chartLabels),
    accountsByType:     charts.accountsByTypeUrl(stats.typeMap, t, ACCOUNT_TYPE_MAP),
    accountsByLender:   charts.accountsByLenderUrl(stats.lenderMap),
    outstandingVsSanct: charts.outstandingVsSanctionedUrl(accounts, chartLabels),
    riskMap:            charts.riskMapUrl(accounts, chartLabels),
    projectedScore:     charts.projectedScoreUrl(projectedScores, chartLabels),
    enquiryTimeline:    charts.enquiryTimelineUrl(data.enquiries || [], data.report_date || null, t, tMonthLabel),
    dpdCharts,
  };

  // ── 8. Render the EJS template ────────────────────────────────────────────
  const html = await ejs.renderFile(
    TEMPLATE_PATH,
    {
      data,
      accounts,
      enquiries:       data.enquiries    || [],
      riskFactors,
      stats,
      profileNote,
      enquiryCounts,
      chartUrls,
      projectedScores,
      dpdCodeToColor,
      formatINR,
      logoDataUri:     LOGO_DATA_URI,
      // i18n helpers
      t,
      lang,
      isRTL,
      tSeverity,
      tStatus,
      tOwnership,
      tAccountType,
      tEnquiryPurpose,
      tScoreBand,
      tMonthLabel,
    },
    { async: true }
  );

  return html;
}

module.exports = { renderCreditReport };
