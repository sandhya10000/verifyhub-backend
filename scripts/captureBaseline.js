'use strict';

const fs = require('fs');
const path = require('path');
const { renderCreditReport } = require('../utils/reportRenderer');

const FIXTURE_DATA = {
  client_name: 'BHUVANESHVAR SONWANI',
  report_date: '2026-03-15',
  pan: 'ABCDE1234F',
  dob: '1990-01-01',
  bureau_control_no: 'B2C-1234567890',
  credit_score: 742,
  score_band: 'Good',
  language: 'en',
  accounts: [
    {
      lender: 'HDFC BANK',
      masked_account_number: 'XXXX1234',
      account_type: 'Personal Loan',
      ownership: 'Individual',
      opened_date: '2022-01-10',
      closed_date: null,
      sanctioned_amount: 300000,
      current_balance: 145000,
      overdue_amount: 0,
      emi_amount: 8500,
      repayment_tenure_months: 48,
      status: 'Active',
      max_dpd: 0,
      dpd_history: [
        { month: '01/26', value: '000' },
        { month: '02/26', value: '000' },
        { month: '03/26', value: '000' }
      ]
    },
    {
      lender: 'SBI CARDS',
      masked_account_number: 'XXXX5678',
      account_type: 'Credit Card',
      ownership: 'Individual',
      opened_date: '2021-06-15',
      closed_date: null,
      sanctioned_amount: 150000,
      current_balance: 32000,
      overdue_amount: 0,
      emi_amount: null,
      repayment_tenure_months: null,
      status: 'Active',
      max_dpd: 30,
      dpd_history: [
        { month: '01/26', value: '030' },
        { month: '02/26', value: '000' },
        { month: '03/26', value: '000' }
      ]
    },
    {
      lender: 'ICICI BANK',
      masked_account_number: 'XXXX9012',
      account_type: 'Auto Loan Personal',
      ownership: 'Individual',
      opened_date: '2019-03-20',
      closed_date: '2024-03-20',
      sanctioned_amount: 600000,
      current_balance: 0,
      overdue_amount: 0,
      emi_amount: 14000,
      repayment_tenure_months: 60,
      status: 'Closed',
      max_dpd: 0,
      dpd_history: []
    }
  ],
  enquiries: [
    {
      lender: 'AXIS BANK',
      enquiry_date: '2026-02-10',
      purpose: 'Credit Card',
      amount: 100000
    },
    {
      lender: 'BAJAJ FINANCE',
      enquiry_date: '2025-11-05',
      purpose: 'Consumer Loan',
      amount: 45000
    }
  ],
  risk_factors: [
    {
      title: 'Recent 30 DPD on SBI CARDS',
      explanation: 'SBI Cards reported 30 days past due within the last quarter. Clear overdue immediately.'
    },
    {
      title: 'Credit Utilization Ratio at 21%',
      explanation: 'Card balance of ₹32,000 against ₹1,50,000 limit is healthy but can be lowered.'
    }
  ],
  projected_scores: [742, 755, 768, 780],
  projection_assumptions: 'Assumes zero 30+ DPD occurrences, timely clearance of current card balance, and no more than one new unsecured inquiry in the next 90 days.',
  foir_percent: 28,
  foir_rating: 'Low Risk',
  max_eligible_amount: 1200000,
  executive_summary: 'The client demonstrates a disciplined credit profile with a 742 CIBIL score, manageable debt obligations, and consistent on-time payment track record across secured and unsecured facilities.',
  recommendation: 'Maintain automatic debit mandates for all existing loans. Keep credit card utilization below 20% to support upward trajectory toward 780+ band.'
};

async function main() {
  const outputDir = path.join(__dirname, '../tests/fixtures');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, 'unbranded_baseline.html');

  console.log('Rendering deterministic fixture report via renderCreditReport...');
  const html = await renderCreditReport(FIXTURE_DATA);

  fs.writeFileSync(outputPath, html, 'utf-8');
  console.log(`Saved baseline to ${outputPath} (${Buffer.byteLength(html, 'utf-8')} bytes, ${html.length} chars)`);

  return html;
}

if (require.main === module) {
  main().catch(err => {
    console.error('Failed to capture baseline:', err);
    process.exit(1);
  });
}

module.exports = { FIXTURE_DATA, main };
