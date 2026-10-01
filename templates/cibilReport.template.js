// ============================================================
// CIBIL REPORT HTML TEMPLATE
// File: templates/cibilReport.template.js
// ============================================================

const escapeHtml = (value) => {
  if (value === null || value === undefined) return "-";

  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

// ============================================================
// FORMAT HELPERS
// ============================================================

const formatDate = (value) => {
  if (!value || value === "-") return "-";

  const clean = String(value).split("+")[0];

  const parts = clean.split("-");

  if (parts.length !== 3) {
    return escapeHtml(value);
  }

  const [year, month, day] = parts;

  return `${day}-${month}-${year}`;
};

const formatAmount = (value) => {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    value === "-" ||
    value === "-1"
  ) {
    return "-";
  }

  const number = Number(value);

  if (Number.isNaN(number)) {
    return escapeHtml(value);
  }

  return `₹ ${number.toLocaleString("en-IN")}`;
};

const safe = (value) => escapeHtml(value ?? "-");

// ============================================================
// COMMON UI COMPONENTS
// ============================================================

const sectionTitle = (title, subtitle = "") => {
  return `
    <div class="section-header">
      <div class="section-title">${safe(title)}</div>
      ${subtitle ? `<div class="section-subtitle">${safe(subtitle)}</div>` : ""}
    </div>
  `;
};

const infoItem = (label, value) => {
  return `
    <div class="info-item">
      <div class="info-label">${safe(label)}</div>
      <div class="info-value">${safe(value)}</div>
    </div>
  `;
};

// ============================================================
// HEADER
// ============================================================

const renderHeader = (data) => {
  return `
    <div class="report-header">

      <div class="header-left">
        <div class="report-title">
          CREDIT INFORMATION REPORT
        </div>

        <div class="report-subtitle">
          CIBIL Credit Report
        </div>
      </div>

      <div class="header-right">
        <div class="header-label">
          Control Number
        </div>

        <div class="header-value">
          ${safe(data.controlNumber)}
        </div>

        <div class="header-label report-version-label">
          Report Version
        </div>

        <div class="header-value">
          ${safe(data.reportVersion)}
        </div>
      </div>

    </div>

    <div class="generated-row">
      <span>Generated On</span>
      <strong>${safe(data.generatedAt)}</strong>
    </div>
  `;
};

// ============================================================
// PERSONAL INFORMATION
// ============================================================

const renderPersonalInformation = (data) => {
  const borrower = data.borrower || {};

  const emails = borrower.emails || [];
  const phones = borrower.phones || [];

  return `
    ${sectionTitle("Personal Information")}

    <div class="info-grid">

      ${infoItem("Full Name", borrower.fullName)}

      ${infoItem("Date of Birth", formatDate(borrower.dob))}

      ${infoItem("Gender", borrower.gender)}

      

    </div>

    <!-- Mobile Numbers -->
    <div class="contact-section">

      <div class="contact-title">
        Mobile Number
      </div>

      <div class="contact-list">
        ${
          phones.length
            ? phones
                .map(
                  (phone, index) => `
                    <div class="contact-box">
                      <div class="contact-label">
                        Mobile ${index + 1}
                      </div>
                      <div class="contact-value">
                        ${safe(phone)}
                      </div>
                    </div>
                  `,
                )
                .join("")
            : `
                <div class="contact-box">
                  <div class="contact-value">-</div>
                </div>
              `
        }
      </div>

    </div>

    <!-- Email IDs -->
    <div class="contact-section">

      <div class="contact-title">
        Email ID
      </div>

      <div class="contact-list">
        ${
          emails.length
            ? emails
                .map(
                  (email, index) => `
                    <div class="contact-box">
                      <div class="contact-label">
                        Email ${index + 1}
                      </div>
                      <div class="contact-value">
                        ${safe(email)}
                      </div>
                    </div>
                  `,
                )
                .join("")
            : `
                <div class="contact-box">
                  <div class="contact-value">-</div>
                </div>
              `
        }
      </div>

    </div>
  `;
};

// ============================================================
// CREDIT SCORE
// ============================================================

const renderCreditScore = (data) => {
  const score = data.score || {};

  return `
    ${sectionTitle("CIBIL Score")}

    <div class="score-container">

      <div class="score-box">

        <div class="score-label">
          CIBIL SCORE
        </div>

        <div class="score-value">
          ${safe(score.value)}
        </div>

      </div>

      <div class="score-details">

        ${infoItem("Score Model", score.model)}

        ${infoItem("Score Name", score.scoreName)}

        ${infoItem("Population Rank", score.populationRank)}

      </div>

    </div>
  `;
};

// ============================================================
// ACCOUNT SUMMARY
// ============================================================

const renderAccountSummary = (data) => {
  const summary = data.summary || {};

  return `
    ${sectionTitle("Account Summary")}

    <div class="summary-grid">

      <div class="summary-card">
        <div class="summary-label">
          Total Accounts
        </div>

        <div class="summary-value">
          ${safe(summary.totalAccounts)}
        </div>
      </div>

      <div class="summary-card">
        <div class="summary-label">
          Active Accounts
        </div>

        <div class="summary-value">
          ${safe(summary.activeAccounts)}
        </div>
      </div>

      <div class="summary-card">
        <div class="summary-label">
          Closed Accounts
        </div>

        <div class="summary-value">
          ${safe(summary.closedAccounts)}
        </div>
      </div>

      <div class="summary-card">
        <div class="summary-label">
          Total Current Balance
        </div>

        <div class="summary-value">
          ${formatAmount(summary.totalCurrentBalance)}
        </div>
      </div>

      <div class="summary-card">
        <div class="summary-label">
          Total High Balance
        </div>

        <div class="summary-value">
          ${formatAmount(summary.totalHighBalance)}
        </div>
      </div>

      <div class="summary-card">
        <div class="summary-label">
          Total Amount Past Due
        </div>

        <div class="summary-value">
          ${formatAmount(summary.totalPastDue)}
        </div>
      </div>

    </div>
  `;
};

// ============================================================
// ADDRESS
// ============================================================

const renderAddresses = (data) => {
  const addresses = data.borrower?.addresses || [];

  if (!addresses.length) {
    return `
      ${sectionTitle("Address Information")}

      <div class="empty-box">
        No address information available.
      </div>
    `;
  }

  return `
    ${sectionTitle("Address Information")}

    <div class="table-wrapper">

      <table>

        <thead>
          <tr>
            <th>#</th>
            <th>Address</th>
            <th>City</th>
            <th>State</th>
            <th>PIN Code</th>
            <th>Reported Date</th>
            <th>Source</th>
          </tr>
        </thead>

        <tbody>

          ${addresses
            .map(
              (item, index) => `
                <tr>
                  <td>${index + 1}</td>
                  <td>${safe(item.address)}</td>
                  <td>${safe(item.city)}</td>
                  <td>${safe(item.state)}</td>
                  <td>${safe(item.pincode)}</td>
                  <td>${formatDate(item.reportedDate)}</td>
                  <td>${safe(item.origin)}</td>
                </tr>
              `,
            )
            .join("")}

        </tbody>

      </table>

    </div>
  `;
};

// ============================================================
// IDENTIFIERS
// ============================================================

const renderIdentifiers = (data) => {
  const identifiers = data.borrower?.identifiers || [];

  if (!identifiers.length) {
    return "";
  }

  return `
    ${sectionTitle("Identifiers")}

    <div class="table-wrapper">

      <table>

        <thead>
          <tr>
            <th>#</th>
            <th>Identifier Type</th>
            <th>Value</th>
          </tr>
        </thead>

        <tbody>

          ${identifiers
            .map(
              (item, index) => `
                <tr>
                  <td>${index + 1}</td>
                  <td>${safe(
                    item.type || item.symbol || item.IdentifierType || "-",
                  )}</td>

                  <td>${safe(
                    item.value || item.IdentifierValue || item.id || "-",
                  )}</td>
                </tr>
              `,
            )
            .join("")}

        </tbody>

      </table>

    </div>
  `;
};

// ============================================================
// EMPLOYMENT
// ============================================================

const renderEmployment = (data) => {
  const employment = data.employment || {};

  return `
    ${sectionTitle("Employment Information")}

    <div class="info-grid">

      ${infoItem("Employer", employment.employer)}

      ${infoItem("Occupation", employment.occupation)}

      ${infoItem("Date Reported", formatDate(employment.dateReported))}

    </div>
  `;
};
// ============================================================
// PAYMENT HISTORY HELPERS
// ============================================================

const PAYMENT_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// ============================================================
// PAYMENT HISTORY HELPERS
// ============================================================

// Get year/month from different possible date formats
const getPaymentYearMonth = (value) => {
  if (!value) return null;

  const raw = String(value).trim();

  // YYYY-MM-DD
  let match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);

  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2]),
    };
  }

  // DD-MM-YYYY
  match = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);

  if (match) {
    return {
      year: Number(match[3]),
      month: Number(match[2]),
    };
  }

  // YYYY/MM/DD
  match = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);

  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2]),
    };
  }

  // DD/MM/YYYY
  match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);

  if (match) {
    return {
      year: Number(match[3]),
      month: Number(match[2]),
    };
  }

  // YYYY-MM
  match = raw.match(/^(\d{4})-(\d{1,2})$/);

  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2]),
    };
  }

  return null;
};

// ============================================================
// GET PAYMENT STATUS
// ============================================================

const getPaymentDisplayStatus = (item) => {
  if (!item) return "-";

  // Prefer asset classification if API provides it
  const status =
    item.status ??
    item.paymentStatus ??
    item.assetClassification ??
    item.assetClass ??
    "-";

  if (status === null || status === undefined || String(status).trim() === "") {
    return "-";
  }

  return String(status);
};

// ============================================================
// LATEST MONTHS FIRST
// Dec → Nov → Oct → ... → Jan
// ============================================================

const PAYMENT_MONTH_NUMBERS = Array.from(
  { length: 12 },
  (_, index) => 12 - index,
);

// ============================================================
// PAYMENT STATUS CLASS
// ============================================================

const getPaymentStatusClass = (status) => {
  if (
    status === null ||
    status === undefined ||
    status === "-" ||
    status === ""
  ) {
    return "";
  }

  const value = String(status).trim().toUpperCase();

  // Good / Standard
  if (
    value === "0" ||
    value === "000" ||
    value === "STD" ||
    value === "000/STD"
  ) {
    return "status-good";
  }

  // Unknown / Not Reported
  if (value === "XXX" || value === "NA" || value === "N/A") {
    return "status-unknown";
  }

  // Asset Classification / Overdue
  if (value.includes("SUB") || value.includes("DBT") || value.includes("LSS")) {
    return "status-warning";
  }

  // Numeric DPD
  const numeric = Number(value);

  if (!Number.isNaN(numeric) && numeric > 0) {
    return "status-warning";
  }

  return "";
};

// ============================================================
// PAYMENT HISTORY
// YEAR WISE / MONTH WISE
// LATEST YEAR FIRST
// LATEST MONTH FIRST
// ============================================================

const renderPaymentHistory = (history) => {
  if (!history || !history.length) {
    return `
      <div class="payment-history">
        <div class="payment-title">
          Payment History / Asset Classification
        </div>

        <div class="empty-box">
          No payment history available.
        </div>
      </div>
    `;
  }

  // ============================================================
  // GROUP PAYMENT HISTORY BY YEAR
  // ============================================================

  const yearlyData = {};

  history.forEach((item) => {
    const dateInfo = getPaymentYearMonth(
      item?.date || item?.paymentDate || item?.month || item?.reportDate,
    );

    if (!dateInfo) {
      return;
    }

    const { year, month } = dateInfo;

    // Ignore invalid months
    if (month < 1 || month > 12) {
      return;
    }

    if (!yearlyData[year]) {
      yearlyData[year] = {};
    }

    // Month number 1-12
    yearlyData[year][month] = getPaymentDisplayStatus(item);
  });

  // ============================================================
  // SORT YEARS
  // LATEST YEAR FIRST
  //
  // Example:
  // 2026
  // 2025
  // 2024
  // 2023
  // ============================================================

  const years = Object.keys(yearlyData)
    .map(Number)
    .sort((a, b) => b - a);

  // ============================================================
  // NO VALID DATA
  // ============================================================

  if (!years.length) {
    return `
      <div class="payment-history">
        <div class="payment-title">
          Payment History / Asset Classification
        </div>

        <div class="empty-box">
          Payment history dates could not be processed.
        </div>
      </div>
    `;
  }

  // ============================================================
  // BUILD YEAR ROWS
  //
  // Latest month first:
  //
  // Dec | Nov | Oct | Sep | ... | Jan
  // ============================================================

  const yearRows = years
    .map((year) => {
      const months = yearlyData[year];

      return `
        <tr>

          <td class="payment-year">
            ${safe(year)}
          </td>

          ${PAYMENT_MONTH_NUMBERS.map((monthNumber) => {
            const status = months[monthNumber] ?? "-";

            return `
              <td class="${getPaymentStatusClass(status)}">
                ${safe(status)}
              </td>
            `;
          }).join("")}

        </tr>
      `;
    })
    .join("");

  // ============================================================
  // BUILD MONTH HEADERS
  //
  // Dec | Nov | Oct | Sep | ... | Jan
  // ============================================================

  const monthHeaders = PAYMENT_MONTH_NUMBERS.map((monthNumber) => {
    return `
        <th>
          ${PAYMENT_MONTHS[monthNumber - 1]}
        </th>
      `;
  }).join("");

  // ============================================================
  // FINAL PAYMENT HISTORY UI
  // ============================================================

  return `
    <div class="payment-history">

      <div class="payment-title">
        Payment History
      </div>

      <div class="payment-classification-title">
        Payment History/Asset Classification:
      </div>

      <div class="payment-table-wrapper">

        <table class="payment-table">

          <thead>

            <tr>

              <th class="year-column">
                Year
              </th>

              ${monthHeaders}

            </tr>

          </thead>

          <tbody>

            ${yearRows}

          </tbody>

        </table>

      </div>

      <div class="payment-note">

        Payment status is displayed based on the bureau response.
        Values such as 000/STD, XXX, SUB, DBT, LSS, etc.
        are displayed as received wherever available.

      </div>

    </div>
  `;
};

// ============================================================
// ACCOUNT
// ============================================================

const renderAccount = (account, index) => {
  return `
    <div class="account-card">

      <div class="account-header">

        <div>
          <div class="account-number">
            Account ${index + 1}
          </div>

          <div class="creditor-name">
            ${safe(account.creditorName)}
          </div>
        </div>

        <div class="account-status">
          ${safe(account.status)}
        </div>

      </div>

      <div class="account-info-grid">

        ${infoItem("Account Number", account.accountNumber)}

        ${infoItem("Account Type", account.accountType)}

        ${infoItem("Account Type Code", account.accountTypeCode)}

        ${infoItem("Date Opened", formatDate(account.dateOpened))}

        ${infoItem("Date Closed", formatDate(account.dateClosed))}

        ${infoItem("Date Reported", formatDate(account.dateReported))}

        ${infoItem("Current Balance", formatAmount(account.currentBalance))}

        ${infoItem("High Balance", formatAmount(account.highBalance))}

        ${infoItem("Credit Limit", formatAmount(account.creditLimit))}

        ${infoItem("Cash Limit", formatAmount(account.cashLimit))}

        ${infoItem("Amount Past Due", formatAmount(account.amountPastDue))}

        ${infoItem(
          "Interest Rate",
          account.interestRate === "-1" ? "-" : account.interestRate,
        )}

        ${infoItem("EMI Amount", formatAmount(account.emi))}

        ${infoItem(
          "Tenure",
          account.repaymentTenure === "-1" ? "-" : account.repaymentTenure,
        )}

        ${infoItem("Last Payment Date", formatDate(account.dateLastPayment))}

        ${infoItem("Written Off Amount", formatAmount(account.writtenOff))}

        ${infoItem("Settlement Amount", formatAmount(account.settlementAmount))}

      </div>

      ${renderPaymentHistory(account.paymentHistory)}

    </div>
  `;
};

// ============================================================
// ACCOUNTS
// ============================================================

const renderAccounts = (data) => {
  const accounts = data.accounts || [];

  if (!accounts.length) {
    return `
      ${sectionTitle("Credit Accounts")}

      <div class="empty-box">
        No credit accounts found.
      </div>
    `;
  }

  return `
    ${sectionTitle("Credit Accounts", `${accounts.length} account(s) found`)}

    ${accounts.map((account, index) => renderAccount(account, index)).join("")}
  `;
};

// ============================================================
// ENQUIRIES
// ============================================================

const renderEnquiries = (data) => {
  const inquiries = data.inquiries || [];

  if (!inquiries.length) {
    return `
      ${sectionTitle("Credit Enquiries")}

      <div class="empty-box">
        No credit enquiries found.
      </div>
    `;
  }

  return `
    ${sectionTitle("Credit Enquiries", `${inquiries.length} enquiry/enquiries`)}

    <div class="table-wrapper">

      <table>

        <thead>

          <tr>
            <th>#</th>
            <th>Subscriber</th>
            <th>Inquiry Date</th>
            <th>Inquiry Type</th>
            <th>Amount</th>
            <th>Control Number</th>
          </tr>

        </thead>

        <tbody>

          ${inquiries
            .map(
              (item, index) => `
                <tr>

                  <td>${index + 1}</td>

                  <td>
                    ${safe(item.subscriberName)}
                  </td>

                  <td>
                    ${formatDate(item.inquiryDate)}
                  </td>

                  <td>
                    ${safe(item.inquiryType)}
                  </td>

                  <td>
                    ${formatAmount(item.amount)}
                  </td>

                  <td>
                    ${safe(item.controlNumber)}
                  </td>

                </tr>
              `,
            )
            .join("")}

        </tbody>

      </table>

    </div>
  `;
};

// ============================================================
// MAIN TEMPLATE
// ============================================================

const buildCibilReportHtml = (data) => {
  return `
<!DOCTYPE html>

<html>

<head>

<meta charset="UTF-8" />

<title>CIBIL Credit Information Report</title>
<style>
  /* ============================================================
     GLOBAL
  ============================================================ */

  * {
    box-sizing: border-box;
  }

  html,
  body {
    margin: 0;
    padding: 0;
  }

  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 10px;
    line-height: 1.45;
    color: #1f2937;
    background: #ffffff;
  }

  /* ============================================================
     REPORT HEADER
  ============================================================ */

  .report-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;

    padding: 22px 24px;

    background: linear-gradient(135deg, #0f2f5f 0%, #174f91 100%);
    border-radius: 0 0 10px 10px;

    color: #ffffff;
  }

  .header-left {
    flex: 1;
  }

  .report-title {
    font-size: 21px;
    font-weight: 800;
    letter-spacing: 0.5px;
    color: #ffffff;
  }

  .report-subtitle {
    margin-top: 6px;

    font-size: 11px;
    font-weight: 400;

    color: #dbeafe;
  }

  .header-right {
    min-width: 190px;
    padding-left: 20px;

    text-align: right;

    border-left: 1px solid rgba(255, 255, 255, 0.25);
  }

  .header-label {
    font-size: 7px;
    font-weight: 700;

    color: #bfdbfe;

    text-transform: uppercase;
    letter-spacing: 0.8px;
  }

  .header-value {
    margin-top: 3px;

    font-size: 10px;
    font-weight: 700;

    color: #ffffff;

    word-break: break-word;
  }

  .report-version-label {
    margin-top: 12px;
  }

  /* ============================================================
     GENERATED ROW
  ============================================================ */

  .generated-row {
    display: flex;
    justify-content: space-between;
    align-items: center;

    padding: 8px 24px;

    background: #f1f5f9;

    border-bottom: 1px solid #dbe3ec;

    color: #64748b;

    font-size: 8px;
  }

  .generated-row strong {
    color: #1e293b;
    font-size: 9px;
  }

  /* ============================================================
     SECTION HEADER
  ============================================================ */

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;

    margin-top: 20px;
    margin-bottom: 10px;

    padding-bottom: 7px;

    border-bottom: 2px solid #e2e8f0;
  }

  .section-title {
    position: relative;

    padding-left: 9px;

    font-size: 13px;
    font-weight: 800;

    color: #123d70;
  }

  .section-title::before {
    content: "";

    position: absolute;
    left: 0;
    top: 1px;

    width: 3px;
    height: 15px;

    background: #2563eb;

    border-radius: 4px;
  }

  .section-subtitle {
    font-size: 8px;
    font-weight: 600;

    color: #64748b;
  }

  /* ============================================================
     INFO GRID
  ============================================================ */

  .info-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);

    overflow: hidden;

    border: 1px solid #dbe3ec;
    border-radius: 7px;

    background: #ffffff;
  }

  .info-item {
    min-height: 48px;

    padding: 8px 10px;

    background: #ffffff;

    border-right: 1px solid #e5eaf0;
    border-bottom: 1px solid #e5eaf0;
  }

  .info-item:nth-child(3n) {
    border-right: none;
  }

  .info-label {
    margin-bottom: 4px;

    font-size: 7px;
    font-weight: 700;

    color: #64748b;

    text-transform: uppercase;
    letter-spacing: 0.4px;
  }

  .info-value {
    font-size: 9px;
    font-weight: 700;

    color: #1e293b;

    word-break: break-word;
  }

  /* ============================================================
     CREDIT SCORE
  ============================================================ */

  .score-container {
    display: flex;
    gap: 12px;

    align-items: stretch;
  }

  .score-box {
    position: relative;

    width: 185px;

    padding: 16px 12px;

    text-align: center;

    border: 1px solid #cbd5e1;
    border-radius: 9px;

    background: linear-gradient(
      145deg,
      #f8fbff 0%,
      #edf5ff 100%
    );

    box-shadow: 0 3px 10px rgba(15, 47, 95, 0.08);

    overflow: hidden;
  }

  .score-box::before {
    content: "";

    position: absolute;

    left: 0;
    right: 0;
    top: 0;

    height: 4px;

    background: linear-gradient(
      90deg,
      #1d4ed8,
      #3b82f6
    );
  }

  .score-label {
    margin-top: 2px;

    font-size: 8px;
    font-weight: 800;

    color: #64748b;

    letter-spacing: 1px;
  }

  .score-value {
    margin-top: 7px;

    font-size: 36px;
    line-height: 1;

    font-weight: 900;

    color: #123d70;
  }

  .score-details {
    flex: 1;

    display: grid;
    grid-template-columns: repeat(3, 1fr);

    overflow: hidden;

    border: 1px solid #dbe3ec;
    border-radius: 8px;

    background: #ffffff;
  }

  .score-details .info-item {
    min-height: 72px;
  }

  /* ============================================================
     SUMMARY CARDS
  ============================================================ */

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);

    gap: 9px;
  }

  .summary-card {
    position: relative;

    min-height: 75px;

    padding: 11px 12px;

    border: 1px solid #dbe3ec;
    border-radius: 8px;

    background: #ffffff;

    box-shadow: 0 2px 7px rgba(15, 23, 42, 0.05);

    overflow: hidden;
  }

  .summary-card::before {
    content: "";

    position: absolute;

    left: 0;
    top: 0;
    bottom: 0;

    width: 3px;

    background: #2563eb;
  }

  .summary-label {
    padding-left: 3px;

    font-size: 7px;
    font-weight: 700;

    color: #64748b;

    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .summary-value {
    margin-top: 7px;
    padding-left: 3px;

    font-size: 14px;
    font-weight: 800;

    color: #123d70;

    word-break: break-word;
  }

  /* ============================================================
     TABLES
  ============================================================ */

  .table-wrapper {
    width: 100%;

    overflow: hidden;

    border: 1px solid #dbe3ec;
    border-radius: 7px;
  }

  table {
    width: 100%;

    border-collapse: collapse;

    table-layout: fixed;

    font-size: 8px;

    background: #ffffff;
  }

  th {
    padding: 7px 6px;

    background: #eef4fb;

    border-right: 1px solid #d8e1ec;
    border-bottom: 1px solid #cbd5e1;

    color: #1e3a5f;

    font-size: 7px;
    font-weight: 800;

    text-align: left;

    text-transform: uppercase;
    letter-spacing: 0.2px;
  }

  th:last-child {
    border-right: none;
  }

  td {
    padding: 7px 6px;

    border-right: 1px solid #e5eaf0;
    border-bottom: 1px solid #e5eaf0;

    color: #334155;

    font-size: 8px;

    vertical-align: middle;

    word-break: break-word;
  }

  td:last-child {
    border-right: none;
  }

  tbody tr:nth-child(even) td {
    background: #fafcff;
  }

  tbody tr:last-child td {
    border-bottom: none;
  }

  tr {
    page-break-inside: avoid;
  }

  /* ============================================================
     ACCOUNT CARD
  ============================================================ */

  .account-card {
    margin-bottom: 18px;

    border: 1px solid #cfd9e5;

    border-radius: 9px;

    background: #ffffff;

    overflow: hidden;

    box-shadow: 0 3px 9px rgba(15, 23, 42, 0.06);

    page-break-inside: auto;
  }

  .account-header {
    display: flex;
    justify-content: space-between;
    align-items: center;

    padding: 11px 13px;

    background: linear-gradient(
      135deg,
      #edf4fc 0%,
      #f7faff 100%
    );

    border-bottom: 1px solid #d7e0eb;
  }

  .account-number {
    font-size: 7px;
    font-weight: 700;

    color: #64748b;

    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .creditor-name {
    margin-top: 3px;

    font-size: 12px;
    font-weight: 800;

    color: #123d70;
  }

  .account-status {
    padding: 5px 10px;

    border: 1px solid #bfdbfe;

    border-radius: 20px;

    background: #eff6ff;

    color: #1d4ed8;

    font-size: 7px;
    font-weight: 800;

    text-transform: uppercase;
  }

  /* ============================================================
     ACCOUNT INFORMATION
  ============================================================ */

  .account-info-grid {
    display: grid;

    grid-template-columns: repeat(4, 1fr);

    border-bottom: 1px solid #dbe3ec;
  }

  .account-info-grid .info-item {
    min-height: 44px;
  }

/* ============================================================
   PAYMENT HISTORY
============================================================ */

.payment-history {
  padding: 12px 14px 14px;

  background: #ffffff;

  border-top: 1px solid #dbe3ec;
}

.payment-title {
  margin-bottom: 9px;

  font-size: 10px;
  font-weight: 800;

  color: #173f6f;
}

.payment-title::before {
  content: "";

  display: inline-block;

  width: 4px;
  height: 12px;

  margin-right: 6px;

  vertical-align: -2px;

  background: #2563eb;

  border-radius: 3px;
}

.payment-classification-title {
  padding: 8px 9px;

  border: 1px solid #cbd5e1;
  border-bottom: none;

  background: #f8fafc;

  color: #173f6f;

  font-size: 8px;
  font-weight: 800;
}

.payment-table-wrapper {
  width: 100%;

  overflow: hidden;

  border: 1px solid #cbd5e1;
}

.payment-table {
  width: 100%;

  border-collapse: collapse;

  table-layout: fixed;

  background: #ffffff;

  font-size: 7px;
}

/* ============================================================
   PAYMENT HEADER
============================================================ */

.payment-table thead th {
  padding: 7px 3px;

  background: #e8eef7;

  border: 1px solid #c4d0df;

  color: #173f6f;

  font-size: 7px;
  font-weight: 800;

  text-align: center;

  white-space: nowrap;
}

/* Year column */

.payment-table .year-column {
  width: 5.5%;
}

/* Month columns */

.payment-table thead th:not(.year-column) {
  width: 7.875%;
}

/* ============================================================
   PAYMENT BODY
============================================================ */

.payment-table tbody td {
  height: 28px;

  padding: 6px 3px;

  border: 1px solid #cbd5e1;

  color: #334155;

  font-size: 7px;
  font-weight: 600;

  text-align: center;

  vertical-align: middle;

  white-space: nowrap;
}

/* Year */

.payment-table .payment-year {
  background: #f1f5f9;

  color: #173f6f;

  font-size: 8px;

  font-weight: 800;
}

/* Alternate year rows */

.payment-table tbody tr:nth-child(even) td {
  background: #fbfdff;
}

.payment-table tbody tr:nth-child(even) .payment-year {
  background: #eef3f8;
}

/* ============================================================
   PAYMENT STATUS
============================================================ */

/* 000 / STD */

.payment-table td.status-good {
  color: #173f6f;

  font-weight: 800;

  background: #ffffff;
}

/* Overdue / negative classification */

.payment-table td.status-warning {
  color: #b45309;

  font-weight: 800;

  background: #fffaf0;
}

/* XXX / Not reported */

.payment-table td.status-unknown {
  color: #64748b;

  font-weight: 700;

  background: #f8fafc;
}

/* ============================================================
   NOTE
============================================================ */

.payment-note {
  margin-top: 7px;

  padding: 6px 8px;

  border-left: 3px solid #94a3b8;

  background: #f8fafc;

  color: #64748b;

  font-size: 6.5px;

  line-height: 1.5;
}

   
  /* ============================================================
     EMPTY BOX
  ============================================================ */

  .empty-box {
    padding: 15px;

    border: 1px dashed #cbd5e1;

    border-radius: 7px;

    background: #f8fafc;

    color: #64748b;

    text-align: center;

    font-size: 8px;
  }

  /* ============================================================
     FOOTER
  ============================================================ */

  .footer-note {
    margin-top: 22px;

    padding: 11px 12px;

    border-top: 1px solid #dbe3ec;

    background: #f8fafc;

    color: #64748b;

    font-size: 6.5px;

    line-height: 1.6;

    border-radius: 5px;
  }

  /* ============================================================
     PAGE / PDF SETTINGS
  ============================================================ */

  .page-break {
    page-break-before: always;
  }

  @page {
    size: A4;
    margin: 10mm;
  }

  @media print {
    body {
      background: #ffffff;
    }

    .report-header {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .generated-row,
    .summary-card,
    .score-box,
    .account-header,
    th,
    .payment-note,
    .footer-note {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .account-card {
      box-shadow: none;
    }
  }
</style>

</head>

<body>

  ${renderHeader(data)}

  ${renderPersonalInformation(data)}

  ${renderCreditScore(data)}

  ${renderAccountSummary(data)}

  ${renderAddresses(data)}

  ${renderIdentifiers(data)}

  ${renderEmployment(data)}

  ${renderAccounts(data)}

  ${renderEnquiries(data)}

  <div class="footer-note">
    This document is generated from the bureau response received by the
    application. Bureau-provided values are displayed as received wherever
    applicable. This generated document is not itself an official bureau
    certificate unless separately authorized.
  </div>

</body>

</html>
  `;
};

module.exports = {
  buildCibilReportHtml,
};
