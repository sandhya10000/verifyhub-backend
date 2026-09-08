const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const generateCrifPdf = async (apiData, creditReportId) => {
  // ============================================================
  // 1. FIND CRIF B2C REPORT
  // ============================================================

  const findB2CReport = (root) => {
    if (!root || typeof root !== "object") return null;

    if (root["B2C-REPORT"] && typeof root["B2C-REPORT"] === "object") {
      return root["B2C-REPORT"];
    }

    for (const key of Object.keys(root)) {
      const child = root[key];

      if (child && typeof child === "object") {
        const found = findB2CReport(child);

        if (found) return found;
      }
    }

    return null;
  };

  const report = findB2CReport(apiData);

  if (!report) {
    throw new Error("CRIF B2C-REPORT data not found");
  }

  // ============================================================
  // 2. HELPERS
  // ============================================================

  const value = (val, fallback = "-") => {
    if (val === undefined || val === null || val === "") {
      return fallback;
    }

    if (typeof val === "object") {
      try {
        return JSON.stringify(val);
      } catch {
        return fallback;
      }
    }

    return String(val);
  };

  const escapeHtml = (val, fallback = "-") => {
    return value(val, fallback)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  const getObject = (obj, ...keys) => {
    for (const key of keys) {
      if (
        obj &&
        typeof obj === "object" &&
        obj[key] !== undefined &&
        obj[key] !== null
      ) {
        return obj[key];
      }
    }

    return {};
  };

  const getValue = (obj, ...keys) => {
    for (const key of keys) {
      if (
        obj &&
        typeof obj === "object" &&
        obj[key] !== undefined &&
        obj[key] !== null &&
        obj[key] !== ""
      ) {
        return obj[key];
      }
    }

    return null;
  };

  const toArray = (data) => {
    if (!data) return [];

    if (Array.isArray(data)) {
      return data;
    }

    return [data];
  };

  const formatNumber = (val) => {
    if (
      val === undefined ||
      val === null ||
      val === "" ||
      Number.isNaN(Number(val))
    ) {
      return "0";
    }

    return new Intl.NumberFormat("en-IN", {
      maximumFractionDigits: 2,
    }).format(Number(val));
  };

  const formatDate = (dateValue) => {
    if (!dateValue) return "-";

    const date = new Date(dateValue);

    if (Number.isNaN(date.getTime())) {
      return String(dateValue);
    }

    return date.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  };

  const formatJson = (obj) => {
    if (!obj || typeof obj !== "object") {
      return "-";
    }

    try {
      return JSON.stringify(obj, null, 2);
    } catch {
      return "-";
    }
  };

  // ============================================================
  // 3. REPORT SECTIONS
  // ============================================================

  const header = getObject(report, "HEADER");

  const request = getObject(report, "REQUEST");

  const personalInfo = getObject(
    report,
    "PERSONAL-INFO",
    "PERSONAL-INFORMATION",
  );

  const contactInfo = getObject(
    report,
    "CONTACT-DETAILS",
    "CONTACT-INFORMATION",
  );

  const accountsSummary = getObject(report, "ACCOUNTS-SUMMARY");

  const derivedAttributes = getObject(accountsSummary, "DERIVED-ATTRIBUTES");

  const primarySummary = getObject(accountsSummary, "PRIMARY-ACCOUNTS-SUMMARY");

  const secondarySummary = getObject(
    accountsSummary,
    "SECONDARY-ACCOUNTS-SUMMARY",
  );

  const employment = getObject(report, "EMPLOYMENT-DETAILS");

  const enquiries = getObject(report, "ENQUIRY-HISTORY", "ENQUIRIES");

  const personalInfoVariation = getObject(
    report,
    "PERSONAL-INFO-VARIATION",
    "PERSONAL-INFORMATION-VARIATION",
  );

  const addressVariations = getObject(
    personalInfoVariation,
    "ADDRESS-VARIATIONS",
    "ADDRESS-VARIATION",
  );

  const panVariations = getObject(report, "PAN-VARIATIONS", "PAN-VARIATION");

  // ============================================================
  // 4. ADDRESS EXTRACTION
  // ============================================================

  const getAddressVariations = (source) => {
    if (!source || typeof source !== "object") {
      return [];
    }

    const raw =
      source["ADDRESS-VARIATIONS"] || source["ADDRESS-VARIATION"] || source;

    let variations = raw?.VARIATION || raw?.["VARIATION"] || raw;

    if (
      variations &&
      typeof variations === "object" &&
      !Array.isArray(variations)
    ) {
      const possibleArray =
        variations["ADDRESS"] || variations["ITEM"] || variations["VALUE"];

      if (possibleArray) {
        variations = possibleArray;
      }
    }

    return toArray(variations)
      .map((item) => {
        if (item && typeof item === "object") {
          const address =
            getValue(
              item,
              "ADDRESS",
              "ADDRESS-1",
              "VALUE",
              "TEXT",
              "FULL-ADDRESS",
            ) || "-";

          const reportedDate =
            getValue(item, "REPORTED-DATE", "DATE", "REPORTED_DATE") || "-";

          return {
            value: address,
            reportedDate,
          };
        }

        return {
          value: String(item),
          reportedDate: "-",
        };
      })
      .filter((item) => item.value && item.value !== "-");
  };

  const addressVariationList = getAddressVariations(personalInfoVariation);

  // ============================================================
  // IMPORTANT:
  // request/contactInfo are defined BEFORE primaryAddress.
  // ============================================================

  const primaryAddress =
    getValue(request, "ADDRESS-1", "ADDRESS", "CURRENT-ADDRESS") ||
    getValue(contactInfo, "ADDRESS-1", "ADDRESS", "CURRENT-ADDRESS") ||
    getValue(personalInfo, "ADDRESS-1", "ADDRESS", "CURRENT-ADDRESS") ||
    (addressVariationList.length ? addressVariationList[0].value : "-");

  // ============================================================
  // 5. BASIC PERSONAL DETAILS
  // ============================================================

  const name =
    getValue(request, "NAME", "FULL-NAME") ||
    getValue(personalInfo, "NAME", "FULL-NAME") ||
    "-";

  const firstName = getValue(personalInfo, "FIRST-NAME", "FIRST_NAME") || "-";

  const lastName = getValue(personalInfo, "LAST-NAME", "LAST_NAME") || "-";

  const dob =
    getValue(request, "DOB", "DATE-OF-BIRTH") ||
    getValue(personalInfo, "DOB", "DATE-OF-BIRTH") ||
    "-";

  const gender =
    getValue(request, "GENDER") || getValue(personalInfo, "GENDER") || "-";

  const mobile =
    getValue(request, "MOBILE", "MOBILE-NUMBER", "PHONE") ||
    getValue(contactInfo, "MOBILE", "MOBILE-NUMBER", "PHONE") ||
    "-";

  const email =
    getValue(request, "EMAIL", "EMAIL-ID", "EMAIL-ADDRESS") ||
    getValue(contactInfo, "EMAIL", "EMAIL-ID", "EMAIL-ADDRESS") ||
    "-";

  const pan =
    getValue(request, "PAN", "PAN-NUMBER") ||
    getValue(personalInfo, "PAN", "PAN-NUMBER") ||
    "-";

  // ============================================================
  // 6. REPORT INFORMATION
  // ============================================================

  const reportNumber =
    getValue(header, "REPORT-ID", "REPORT_NUMBER", "REPORT-NUMBER") || "-";

  const reportDate =
    getValue(header, "DATE-OF-ISSUE", "DATE-OF-REQUEST") || "-";

  const formattedDate = formatDate(reportDate);

  const preparedFor = getValue(header, "PREPARED-FOR") || "-";

  // ============================================================
  // 7. CREDIT SCORE
  // ============================================================

  const rawScore =
    apiData?.data?.score ??
    apiData?.score ??
    report?.["CREDIT-SCORE"] ??
    report?.["SCORE"] ??
    null;

  const score =
    rawScore !== null &&
    rawScore !== undefined &&
    rawScore !== "" &&
    !Number.isNaN(Number(rawScore))
      ? Number(rawScore)
      : null;

  let scoreStatus = "Not Available";

  let scoreDescription = "Credit score information is not available.";

  if (score !== null) {
    if (score >= 750) {
      scoreStatus = "Excellent";
      scoreDescription =
        "Your credit profile indicates a strong credit standing.";
    } else if (score >= 700) {
      scoreStatus = "Good";
      scoreDescription =
        "Your credit profile indicates a good credit standing.";
    } else if (score >= 650) {
      scoreStatus = "Fair";
      scoreDescription =
        "Your credit profile indicates a moderate credit standing.";
    } else {
      scoreStatus = "Needs Improvement";
      scoreDescription = "Your credit profile may require improvement.";
    }
  }

  // ============================================================
  // 8. ACCOUNT DATA
  // ============================================================

  const responses = getObject(report, "RESPONSES");

  let accounts = responses?.RESPONSE || responses?.["RESPONSE"] || [];

  if (accounts && typeof accounts === "object" && !Array.isArray(accounts)) {
    accounts = [accounts];
  }

  accounts = toArray(accounts);

  // ============================================================
  // 9. ACCOUNT SUMMARY
  // ============================================================

  const totalAccounts =
    Number(primarySummary?.["PRIMARY-NUMBER-OF-ACCOUNTS"] || 0) +
      Number(secondarySummary?.["SECONDARY-NUMBER-OF-ACCOUNTS"] || 0) ||
    accounts.length;

  const activeAccounts =
    Number(primarySummary?.["PRIMARY-ACTIVE-NUMBER-OF-ACCOUNTS"] || 0) +
    Number(secondarySummary?.["SECONDARY-ACTIVE-NUMBER-OF-ACCOUNTS"] || 0);

  const overdueAccounts =
    Number(primarySummary?.["PRIMARY-OVERDUE-NUMBER-OF-ACCOUNTS"] || 0) +
    Number(secondarySummary?.["SECONDARY-OVERDUE-NUMBER-OF-ACCOUNTS"] || 0);

  const securedAccounts =
    Number(primarySummary?.["PRIMARY-SECURED-NUMBER-OF-ACCOUNTS"] || 0) +
    Number(secondarySummary?.["SECONDARY-SECURED-NUMBER-OF-ACCOUNTS"] || 0);

  const unsecuredAccounts =
    Number(primarySummary?.["PRIMARY-UNSECURED-NUMBER-OF-ACCOUNTS"] || 0) +
    Number(secondarySummary?.["SECONDARY-UNSECURED-NUMBER-OF-ACCOUNTS"] || 0);

  const currentBalance =
    Number(primarySummary?.["PRIMARY-CURRENT-BALANCE"] || 0) +
    Number(secondarySummary?.["SECONDARY-CURRENT-BALANCE"] || 0);

  const sanctionedAmount =
    Number(primarySummary?.["PRIMARY-SANCTIONED-AMOUNT"] || 0) +
    Number(secondarySummary?.["SECONDARY-SANCTIONED-AMOUNT"] || 0);

  const disbursedAmount =
    Number(primarySummary?.["PRIMARY-DISBURSED-AMOUNT"] || 0) +
    Number(secondarySummary?.["SECONDARY-DISBURSED-AMOUNT"] || 0);

  // ============================================================
  // 10. DERIVED ATTRIBUTES
  // ============================================================

  const creditHistoryYears =
    getValue(derivedAttributes, "LENGTH-OF-CREDIT-HISTORY-YEAR") || 0;

  const averageAccountYears =
    getValue(derivedAttributes, "AVERAGE-ACCOUNT-AGE-YEAR") || 0;

  const averageAccountMonths =
    getValue(derivedAttributes, "AVERAGE-ACCOUNT-AGE-MONTH") || 0;

  const enquiriesLastSixMonths =
    getValue(
      derivedAttributes,
      "INQURIES-IN-LAST-SIX-MONTHS",
      "INQUIRIES-IN-LAST-SIX-MONTHS",
    ) || 0;

  const newAccountsLastSixMonths =
    getValue(derivedAttributes, "NEW-ACCOUNTS-IN-LAST-SIX-MONTHS") || 0;

  // ============================================================
  // 11. PAYMENT HISTORY
  // ============================================================

  const normalizePaymentHistory = (raw) => {
    if (raw === undefined || raw === null) {
      return [];
    }

    let text = String(raw);

    /*
      CRIF sometimes breaks the string in the middle because
      of formatting:

      "Dec:2022,513/ST D"
      "Mar:2022,481/S TD"
      "Jun:2021,268/ STD"
      "Sep:2020,X XX/XXX"

      Remove whitespace that occurs INSIDE payment history.
    */

    text = text.replace(/\r?\n/g, "").trim();

    // Remove spaces around separators
    text = text
      .replace(/\s*\|\s*/g, "|")
      .replace(/\s*:\s*/g, ":")
      .replace(/\s*,\s*/g, ",")
      .replace(/\s*\/\s*/g, "/");

    // Fix CRIF OCR/formatting spaces inside status and amount.
    text = text
      .replace(/\b(\d{3})\s+([A-Za-z]{2,3})\b/g, "$1$2")
      .replace(/\b(ST|STD|SUB|DBT|LSS|SMA|DA|XXX)\s+/gi, "$1");

    // Specific common CRIF broken patterns.
    text = text
      .replace(/X\s+XX/g, "XXX")
      .replace(/S\s+TD/gi, "STD")
      .replace(/S\s+TD/gi, "STD")
      .replace(/S\s+UB/gi, "SUB")
      .replace(/D\s+BT/gi, "DBT")
      .replace(/L\s+SS/gi, "LSS")
      .replace(/S\s+MA/gi, "SMA");

    if (!text || text === "-") {
      return [];
    }

    return text
      .split("|")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        /*
          Expected:

          Aug:2023,000/STD
          Jul:2023,329/STD
          Sep:2020,XXX/XXX
        */

        const match = entry.match(
          /^([A-Za-z]{3})\s*:\s*(\d{4})\s*,\s*([^/|]+?)\s*\/\s*([^|]+)$/i,
        );

        if (!match) {
          return {
            month: "-",
            year: "-",
            amount: entry,
            status: "-",
          };
        }

        return {
          month: match[1],
          year: match[2],
          amount: match[3].replace(/\s+/g, "").trim(),
          status: match[4].replace(/\s+/g, "").trim().toUpperCase(),
        };
      });
  };

  const paymentStatusClass = (status) => {
    const s = String(status || "")
      .trim()
      .toUpperCase();

    if (s === "STD") {
      return "payment-status payment-status-std";
    }

    if (s === "XXX") {
      return "payment-status payment-status-xxx";
    }

    if (/SUB|DBT|LSS|SMA|DA/.test(s)) {
      return "payment-status payment-status-alert";
    }

    return "payment-status";
  };

  const renderPaymentHistory = (rawHistory) => {
    const history = normalizePaymentHistory(rawHistory);

    if (!history.length) {
      return `
        <div class="payment-empty">
          No payment history available
        </div>
      `;
    }

    return `
      <div class="payment-table-wrap">
        <table class="payment-table">
          <thead>
            <tr>
              <th>Month</th>
              <th>Year</th>
              <th>Amount</th>
              <th>Status</th>
            </tr>
          </thead>

          <tbody>
            ${history
              .map(
                (row) => `
                  <tr>
                    <td>
                      ${escapeHtml(row.month)}
                    </td>

                    <td>
                      ${escapeHtml(row.year)}
                    </td>

                    <td>
                      ${escapeHtml(row.amount)}
                    </td>

                    <td>
                      <span class="${paymentStatusClass(row.status)}">
                        ${escapeHtml(row.status)}
                      </span>
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
  // 12. ACCOUNT HTML
  // ============================================================

  const accountsHtml = accounts.length
    ? accounts
        .map((item, index) => {
          const loan =
            item?.["LOAN-DETAILS"] || item?.["LOAN_DETAIL"] || item || {};

          const accountStatus = getValue(loan, "ACCOUNT-STATUS") || "-";

          const accountType = getValue(loan, "ACCT-TYPE") || "Credit Account";

          const accountNumber =
            getValue(loan, "ACCT-NUMBER", "ACCOUNT-NUMBER") || "-";

          const creditGuarantor = getValue(loan, "CREDIT-GUARANTOR") || "-";

          const ownership = getValue(loan, "OWNERSHIP-IND") || "-";

          const dateReported = getValue(loan, "DATE-REPORTED") || "-";

          const disbursedDate = getValue(loan, "DISBURSED-DT") || "-";

          const disbursedAmt = getValue(loan, "DISBURSED-AMT") || 0;

          const currentBal = getValue(loan, "CURRENT-BAL") || 0;

          const overdueAmt = getValue(loan, "OVERDUE-AMT") || 0;

          const lastPaymentDate = getValue(loan, "LAST-PAYMENT-DATE") || "-";

          const writeOffAmt = getValue(loan, "WRITE-OFF-AMT") || 0;

          const paymentHistory = getValue(
            loan,
            "COMBINED-PAYMENT-HISTORY",
            "COMBINED_PAYMENT_HISTORY",
            "PAYMENT-HISTORY",
            "PAYMENT_HISTORY",
          );

          return `
            <div class="account-card">

              <div class="account-header">

                <div class="account-title">
                  Account ${index + 1}
                  <span class="account-separator">
                    •
                  </span>
                  ${escapeHtml(accountType)}
                </div>

                <div class="account-status">
                  ${escapeHtml(accountStatus)}
                </div>

              </div>

              <div class="account-body">

                <div class="account-grid">

                  <div class="account-field">
                    <div class="account-field-label">
                      Account Number
                    </div>
                    <div class="account-field-value">
                      ${escapeHtml(accountNumber)}
                    </div>
                  </div>

                  <div class="account-field">
                    <div class="account-field-label">
                      Credit Guarantor
                    </div>
                    <div class="account-field-value">
                      ${escapeHtml(creditGuarantor)}
                    </div>
                  </div>

                  <div class="account-field">
                    <div class="account-field-label">
                      Account Type
                    </div>
                    <div class="account-field-value">
                      ${escapeHtml(accountType)}
                    </div>
                  </div>

                  <div class="account-field">
                    <div class="account-field-label">
                      Ownership
                    </div>
                    <div class="account-field-value">
                      ${escapeHtml(ownership)}
                    </div>
                  </div>

                  <div class="account-field">
                    <div class="account-field-label">
                      Date Reported
                    </div>
                    <div class="account-field-value">
                      ${escapeHtml(dateReported)}
                    </div>
                  </div>

                  <div class="account-field">
                    <div class="account-field-label">
                      Disbursed Date
                    </div>
                    <div class="account-field-value">
                      ${escapeHtml(disbursedDate)}
                    </div>
                  </div>

                  <div class="account-field">
                    <div class="account-field-label">
                      Disbursed Amount
                    </div>
                    <div class="account-field-value">
                      ₹ ${escapeHtml(formatNumber(disbursedAmt))}
                    </div>
                  </div>

                  <div class="account-field">
                    <div class="account-field-label">
                      Current Balance
                    </div>
                    <div class="account-field-value">
                      ₹ ${escapeHtml(formatNumber(currentBal))}
                    </div>
                  </div>

                  <div class="account-field">
                    <div class="account-field-label">
                      Overdue Amount
                    </div>
                    <div class="account-field-value">
                      ₹ ${escapeHtml(formatNumber(overdueAmt))}
                    </div>
                  </div>

                  <div class="account-field">
                    <div class="account-field-label">
                      Last Payment Date
                    </div>
                    <div class="account-field-value">
                      ${escapeHtml(lastPaymentDate)}
                    </div>
                  </div>

                  <div class="account-field">
                    <div class="account-field-label">
                      Write Off Amount
                    </div>
                    <div class="account-field-value">
                      ₹ ${escapeHtml(formatNumber(writeOffAmt))}
                    </div>
                  </div>

                  <div class="account-field">
                    <div class="account-field-label">
                      Account Status
                    </div>
                    <div class="account-field-value">
                      ${escapeHtml(accountStatus)}
                    </div>
                  </div>

                </div>

                <div class="payment-box">

                  <div class="payment-title">
                    Payment History
                  </div>

                  ${renderPaymentHistory(paymentHistory)}

                </div>

              </div>

            </div>
          `;
        })
        .join("")
    : `
      <div class="empty-state">
        No account details are available
        in this CRIF report.
      </div>
    `;

  // ============================================================
  // 13. ADDRESS VARIATIONS HTML
  // ============================================================

  const addressVariationsHtml = addressVariationList.length
    ? `
        <div class="address-table-wrap">

          <table class="address-table">

            <thead>
              <tr>
                <th>Address</th>
                <th>Reported Date</th>
              </tr>
            </thead>

            <tbody>

              ${addressVariationList
                .map(
                  (item) => `
                    <tr>

                      <td>
                        ${escapeHtml(item.value)}
                      </td>

                      <td>
                        ${escapeHtml(item.reportedDate)}
                      </td>

                    </tr>
                  `,
                )
                .join("")}

            </tbody>

          </table>

        </div>
      `
    : `
        <div class="no-data">
          No address variations available
        </div>
      `;

  // ============================================================
  // 14. PAN VARIATIONS
  // ============================================================

  const panVariationsHtml =
    panVariations &&
    typeof panVariations === "object" &&
    Object.keys(panVariations).length
      ? `
        <pre class="json-value">
${escapeHtml(formatJson(panVariations))}
        </pre>
      `
      : `
        <div class="no-data">
          No PAN variations available
        </div>
      `;

  // ============================================================
  // 15. HTML
  // ============================================================

  const html = `
<!DOCTYPE html>

<html>

<head>

<meta charset="UTF-8">

<title>
  CRIF Credit Information Report
</title>

<style>

* {
  box-sizing: border-box;
}

@page {
  size: A4;
  margin: 15mm 12mm 18mm 12mm;
}

html,
body {
  margin: 0;
  padding: 0;
}

body {
  font-family:
    Arial,
    Helvetica,
    sans-serif;

  color: #18324b;

  background: #ffffff;

  font-size: 10px;

  line-height: 1.45;
}

/* ============================================================
   HEADER
============================================================ */

.report-header {
  position: relative;

  overflow: hidden;

  min-height: 145px;

  padding: 28px 32px;

  border-radius: 18px;

  color: #ffffff;

  background:
    linear-gradient(
      135deg,
      #0d3155 0%,
      #164b7c 55%,
      #2879c5 100%
    );

  margin-bottom: 18px;
}

.report-header::before {
  content: "";

  position: absolute;

  width: 250px;
  height: 250px;

  border-radius: 50%;

  right: -80px;
  top: -100px;

  background:
    rgba(
      255,
      255,
      255,
      0.08
    );
}

.report-header::after {
  content: "";

  position: absolute;

  width: 160px;
  height: 160px;

  border-radius: 50%;

  right: 30px;
  top: -75px;

  border:
    1px solid
    rgba(
      255,
      255,
      255,
      0.12
    );
}

.brand {
  position: relative;

  z-index: 2;

  font-size: 30px;

  font-weight: 800;

  letter-spacing: -0.5px;

  color: #75c7ff;

  margin-bottom: 3px;
}

.report-title {
  position: relative;

  z-index: 2;

  font-size: 14px;

  letter-spacing: 1px;

  color: #ffffff;

  margin-bottom: 24px;
}

.header-line {
  height: 1px;

  background:
    rgba(
      255,
      255,
      255,
      0.28
    );

  margin-bottom: 15px;
}

.header-meta {
  position: relative;

  z-index: 2;

  display: grid;

  grid-template-columns:
    1fr 1fr 1fr;

  gap: 15px;

  font-size: 9px;
}

.header-meta strong {
  font-size: 10.5px;

  color: #ffffff;
}

/* ============================================================
   SECTION
============================================================ */

.section {
  margin-bottom: 18px;

  page-break-inside: auto;

  break-inside: auto;
}

.section-title {
  font-size: 13px;

  font-weight: 800;

  color: #173f62;

  margin-bottom: 5px;
}

.section-line {
  height: 2px;

  background:
    #d9e7f1;

  margin-bottom: 10px;
}

/* ============================================================
   INFO GRID
============================================================ */

.info-grid {
  display: grid;

  grid-template-columns:
    repeat(2, minmax(0, 1fr));

  gap: 9px;
}

.info-card {
  border:
    1px solid
    #dce9f2;

  border-radius: 9px;

  background: #f7fbfe;

  padding: 10px;

  min-width: 0;

  page-break-inside: avoid;

  break-inside: avoid;
}

.info-card-wide {
  grid-column: 1 / -1;
}

.info-label {
  font-size: 7.5px;

  font-weight: 800;

  color: #70879a;

  text-transform: uppercase;

  letter-spacing: 0.4px;

  margin-bottom: 4px;
}

.info-value {
  font-size: 9.5px;

  font-weight: 600;

  color: #18324b;

  overflow-wrap: anywhere;

  word-break: break-word;
}

.address-value {
  line-height: 1.55;

  white-space: normal;
}

/* ============================================================
   SCORE
============================================================ */

.score-card {
  display: grid;

  grid-template-columns:
    145px 1fr;

  gap: 18px;

  align-items: center;

  border:
    1px solid
    #dce9f2;

  border-radius: 14px;

  background: #f7fbfe;

  padding: 15px;

  page-break-inside: avoid;
}

.score-circle {
  width: 125px;
  height: 125px;

  border-radius: 50%;

  border:
    8px solid
    #2879c5;

  display: flex;

  flex-direction: column;

  align-items: center;

  justify-content: center;

  margin: auto;
}

.score-number {
  font-size: 30px;

  font-weight: 800;

  color: #173f62;
}

.score-label {
  font-size: 8px;

  color: #70879a;

  text-transform: uppercase;
}

.score-status {
  font-size: 16px;

  font-weight: 800;

  color: #2879c5;

  margin-bottom: 5px;
}

.score-description {
  color: #536e84;

  font-size: 9px;

  line-height: 1.6;
}

/* ============================================================
   SUMMARY
============================================================ */

.summary-grid {
  display: grid;

  grid-template-columns:
    repeat(3, minmax(0, 1fr));

  gap: 9px;
}

.summary-card {
  padding: 11px;

  border:
    1px solid
    #dce9f2;

  border-radius: 9px;

  background: #f7fbfe;

  page-break-inside: avoid;
}

.summary-label {
  font-size: 7px;

  color: #70879a;

  font-weight: 800;

  text-transform: uppercase;

  margin-bottom: 5px;
}

.summary-value {
  font-size: 14px;

  font-weight: 800;

  color: #173f62;
}

/* ============================================================
   ACCOUNT CARD
============================================================ */

.account-card {
  border:
    1px solid
    #d8e6ef;

  border-radius: 12px;

  margin-bottom: 14px;

  overflow: hidden;

  page-break-inside: auto;

  break-inside: auto;

  background: #ffffff;
}

.account-header {
  display: flex;

  justify-content: space-between;

  align-items: center;

  gap: 10px;

  padding: 10px 12px;

  background:
    linear-gradient(
      135deg,
      #eaf4fb,
      #f7fbfe
    );

  border-bottom:
    1px solid
    #d8e6ef;
}

.account-title {
  font-size: 10px;

  font-weight: 800;

  color: #173f62;
}

.account-separator {
  margin: 0 4px;

  color: #8aa2b5;
}

.account-status {
  font-size: 7.5px;

  font-weight: 800;

  color: #2879c5;

  text-transform: uppercase;
}

.account-body {
  padding: 11px;
}

.account-grid {
  display: grid;

  grid-template-columns:
    repeat(3, minmax(0, 1fr));

  gap: 8px;
}

.account-field {
  min-width: 0;

  padding: 7px;

  border:
    1px solid
    #e4edf3;

  border-radius: 7px;

  background: #fbfdff;
}

.account-field-label {
  font-size: 6.8px;

  font-weight: 800;

  color: #8194a4;

  text-transform: uppercase;

  margin-bottom: 3px;
}

.account-field-value {
  font-size: 8px;

  font-weight: 600;

  color: #234e70;

  overflow-wrap: anywhere;

  word-break: break-word;
}

/* ============================================================
   PAYMENT HISTORY
============================================================ */

.payment-box {
  padding: 10px;

  background: #f7fbfe;

  border:
    1px solid
    #dce9f2;

  border-radius: 9px;

  margin-top: 10px;

  page-break-inside: auto;

  break-inside: auto;
}

.payment-title {
  color: #234e70;

  font-size: 8px;

  font-weight: 800;

  margin-bottom: 7px;

  text-transform: uppercase;
}

.payment-table-wrap,
.address-table-wrap {
  width: 100%;

  overflow: hidden;
}

.payment-table,
.address-table {
  width: 100%;

  border-collapse: collapse;

  table-layout: fixed;

  font-size: 7.5px;
}

.payment-table th,
.payment-table td,
.address-table th,
.address-table td {
  border:
    1px solid
    #dce7ef;

  padding: 5px 6px;

  text-align: left;

  vertical-align: top;

  overflow-wrap: anywhere;

  word-break: break-word;
}

.payment-table th,
.address-table th {
  background: #eaf4fb;

  color: #315a78;

  font-weight: 800;

  text-transform: uppercase;
}

.payment-table th:nth-child(1),
.payment-table td:nth-child(1) {
  width: 22%;
}

.payment-table th:nth-child(2),
.payment-table td:nth-child(2) {
  width: 18%;
}

.payment-table th:nth-child(3),
.payment-table td:nth-child(3) {
  width: 30%;
}

.payment-table th:nth-child(4),
.payment-table td:nth-child(4) {
  width: 30%;
}

.address-table th:nth-child(1),
.address-table td:nth-child(1) {
  width: 75%;
}

.address-table th:nth-child(2),
.address-table td:nth-child(2) {
  width: 25%;
}

.payment-table tbody tr:nth-child(even),
.address-table tbody tr:nth-child(even) {
  background: #fbfdff;
}

.payment-table thead,
.address-table thead {
  display: table-header-group;
}

.payment-table tr,
.address-table tr {
  page-break-inside: avoid;

  break-inside: avoid;
}

.payment-status {
  display: inline-block;

  padding: 2px 5px;

  border-radius: 4px;

  font-size: 7px;

  font-weight: 800;
}

.payment-status-std {
  background: #e8f7ee;

  color: #237548;
}

.payment-status-xxx {
  background: #eef1f4;

  color: #667786;
}

.payment-status-alert {
  background: #fff0f0;

  color: #a33a3a;
}

.payment-empty,
.no-data {
  color: #7b8e9e;

  font-size: 8px;

  padding: 7px 0;
}

/* ============================================================
   JSON
============================================================ */

.json-value {
  margin: 0;

  white-space: pre-wrap;

  overflow-wrap: anywhere;

  word-break: break-word;

  font-family:
    Arial,
    Helvetica,
    sans-serif;

  font-size: 8px;

  color: #536e84;
}

/* ============================================================
   EMPTY
============================================================ */

.empty-state {
  padding: 20px;

  text-align: center;

  border:
    1px dashed
    #cbdce7;

  border-radius: 9px;

  color: #7b8e9e;

  font-size: 9px;
}

/* ============================================================
   DISCLAIMER
============================================================ */

.disclaimer {
  padding: 12px;

  border:
    1px solid
    #dce9f2;

  border-radius: 9px;

  background: #f7fbfe;

  color: #62798c;

  font-size: 7.5px;

  line-height: 1.6;

  page-break-inside: avoid;
}

.disclaimer strong {
  color: #234e70;
}

/* ============================================================
   PDF
============================================================ */

@media print {

  .section {
    page-break-inside: auto;
  }

  .payment-table thead,
  .address-table thead {
    display: table-header-group;
  }

  .payment-table tr,
  .address-table tr {
    page-break-inside: avoid;
  }

}

</style>

</head>

<body>

<!-- ============================================================
     HEADER
============================================================ -->

<div class="report-header">

  <div class="brand">
    CreditDost
  </div>

  <div class="report-title">
    CRIF CREDIT INFORMATION REPORT
  </div>

  <div class="header-line"></div>

  <div class="header-meta">

    <div>
      <strong>
        ${escapeHtml(name)}
      </strong>
      <br>
      Applicant Name
    </div>

    <div>
      <strong>
        ${escapeHtml(reportNumber)}
      </strong>
      <br>
      Report Number
    </div>

    <div>
      <strong>
        ${escapeHtml(formattedDate)}
      </strong>
      <br>
      Report Date
    </div>

  </div>

</div>

<!-- ============================================================
     CREDIT SCORE
============================================================ -->

<div class="section">

  <div class="section-title">
    Credit Score
  </div>

  <div class="section-line"></div>

  <div class="score-card">

    <div class="score-circle">

      <div class="score-number">
        ${score !== null ? escapeHtml(score) : "-"}
      </div>

      <div class="score-label">
        CRIF Score
      </div>

    </div>

    <div>

      <div class="score-status">
        ${escapeHtml(scoreStatus)}
      </div>

      <div class="score-description">
        ${escapeHtml(scoreDescription)}
      </div>

    </div>

  </div>

</div>

<!-- ============================================================
     PERSONAL INFORMATION
============================================================ -->

<div class="section">

  <div class="section-title">
    Personal Information
  </div>

  <div class="section-line"></div>

  <div class="info-grid">

    <div class="info-card">

      <div class="info-label">
        Full Name
      </div>

      <div class="info-value">
        ${escapeHtml(name)}
      </div>

    </div>

    <div class="info-card">

      <div class="info-label">
        First Name
      </div>

      <div class="info-value">
        ${escapeHtml(firstName)}
      </div>

    </div>

    <div class="info-card">

      <div class="info-label">
        Last Name
      </div>

      <div class="info-value">
        ${escapeHtml(lastName)}
      </div>

    </div>

    <div class="info-card">

      <div class="info-label">
        Date of Birth
      </div>

      <div class="info-value">
        ${escapeHtml(dob)}
      </div>

    </div>

    <div class="info-card">

      <div class="info-label">
        Gender
      </div>

      <div class="info-value">
        ${escapeHtml(gender)}
      </div>

    </div>

    <div class="info-card">

      <div class="info-label">
        PAN
      </div>

      <div class="info-value">
        ${escapeHtml(pan)}
      </div>

    </div>

  </div>

</div>

<!-- ============================================================
     CONTACT INFORMATION
============================================================ -->

<div class="section">

  <div class="section-title">
    Contact Information
  </div>

  <div class="section-line"></div>

  <div class="info-grid">

    <div class="info-card">

      <div class="info-label">
        Mobile Number
      </div>

      <div class="info-value">
        ${escapeHtml(mobile)}
      </div>

    </div>

    <div class="info-card">

      <div class="info-label">
        Email Address
      </div>

      <div class="info-value">
        ${escapeHtml(email)}
      </div>

    </div>

    <div class="info-card info-card-wide">

      <div class="info-label">
        Current / Requested Address
      </div>

      <div class="info-value address-value">
        ${escapeHtml(primaryAddress)}
      </div>

    </div>

  </div>

</div>

<!-- ============================================================
     ACCOUNT SUMMARY
============================================================ -->

<div class="section">

  <div class="section-title">
    Account Summary
  </div>

  <div class="section-line"></div>

  <div class="summary-grid">

    <div class="summary-card">

      <div class="summary-label">
        Total Accounts
      </div>

      <div class="summary-value">
        ${escapeHtml(totalAccounts)}
      </div>

    </div>

    <div class="summary-card">

      <div class="summary-label">
        Active Accounts
      </div>

      <div class="summary-value">
        ${escapeHtml(activeAccounts)}
      </div>

    </div>

    <div class="summary-card">

      <div class="summary-label">
        Overdue Accounts
      </div>

      <div class="summary-value">
        ${escapeHtml(overdueAccounts)}
      </div>

    </div>

    <div class="summary-card">

      <div class="summary-label">
        Secured Accounts
      </div>

      <div class="summary-value">
        ${escapeHtml(securedAccounts)}
      </div>

    </div>

    <div class="summary-card">

      <div class="summary-label">
        Unsecured Accounts
      </div>

      <div class="summary-value">
        ${escapeHtml(unsecuredAccounts)}
      </div>

    </div>

    <div class="summary-card">

      <div class="summary-label">
        Current Balance
      </div>

      <div class="summary-value">
        ₹ ${escapeHtml(formatNumber(currentBalance))}
      </div>

    </div>

    <div class="summary-card">

      <div class="summary-label">
        Sanctioned Amount
      </div>

      <div class="summary-value">
        ₹ ${escapeHtml(formatNumber(sanctionedAmount))}
      </div>

    </div>

    <div class="summary-card">

      <div class="summary-label">
        Disbursed Amount
      </div>

      <div class="summary-value">
        ₹ ${escapeHtml(formatNumber(disbursedAmount))}
      </div>

    </div>

  </div>

</div>

<!-- ============================================================
     CREDIT HISTORY
============================================================ -->

<div class="section">

  <div class="section-title">
    Credit History
  </div>

  <div class="section-line"></div>

  <div class="info-grid">

    <div class="info-card">

      <div class="info-label">
        Length of Credit History
      </div>

      <div class="info-value">
        ${escapeHtml(creditHistoryYears)}
        Years
      </div>

    </div>

    <div class="info-card">

      <div class="info-label">
        Average Account Age
      </div>

      <div class="info-value">
        ${escapeHtml(averageAccountYears)}
        Years
        ${escapeHtml(averageAccountMonths)}
        Months
      </div>

    </div>

    <div class="info-card">

      <div class="info-label">
        Enquiries - Last 6 Months
      </div>

      <div class="info-value">
        ${escapeHtml(enquiriesLastSixMonths)}
      </div>

    </div>

    <div class="info-card">

      <div class="info-label">
        New Accounts - Last 6 Months
      </div>

      <div class="info-value">
        ${escapeHtml(newAccountsLastSixMonths)}
      </div>

    </div>

  </div>

</div>

<!-- ============================================================
     EMPLOYMENT
============================================================ -->

<div class="section">

  <div class="section-title">
    Employment Details
  </div>

  <div class="section-line"></div>

  <div class="info-grid">

    <div class="info-card">

      <div class="info-label">
        Occupation
      </div>

      <div class="info-value">
        ${escapeHtml(getValue(employment, "OCCUPATION") || "-")}
      </div>

    </div>

    <div class="info-card">

      <div class="info-label">
        Employer
      </div>

      <div class="info-value">
        ${escapeHtml(getValue(employment, "EMPLOYER") || "-")}
      </div>

    </div>

    <div class="info-card">

      <div class="info-label">
        Income
      </div>

      <div class="info-value">
        ${escapeHtml(getValue(employment, "INCOME") || "-")}
      </div>

    </div>

    <div class="info-card">

      <div class="info-label">
        Employment Type
      </div>

      <div class="info-value">
        ${escapeHtml(
          getValue(employment, "EMPLOYMENT-TYPE", "EMPLOYMENT_TYPE") || "-",
        )}
      </div>

    </div>

  </div>

</div>

<!-- ============================================================
     LOAN & ACCOUNT DETAILS
============================================================ -->

<div class="section">

  <div class="section-title">
    Loan & Account Details
  </div>

  <div class="section-line"></div>

  ${accountsHtml}

</div>

<!-- ============================================================
     CREDIT ENQUIRIES
============================================================ -->

<div class="section">

  <div class="section-title">
    Credit Enquiries
  </div>

  <div class="section-line"></div>

  <div class="info-grid">

    <div class="info-card">

      <div class="info-label">
        Enquiries - Last 6 Months
      </div>

      <div class="info-value">
        ${escapeHtml(enquiriesLastSixMonths)}
      </div>

    </div>

    <div class="info-card">

      <div class="info-label">
        New Accounts - Last 6 Months
      </div>

      <div class="info-value">
        ${escapeHtml(newAccountsLastSixMonths)}
      </div>

    </div>

  </div>

</div>

<!-- ============================================================
     ADDRESS & IDENTITY
============================================================ -->

<div class="section">

  <div class="section-title">
    Address & Identity Variations
  </div>

  <div class="section-line"></div>

  <div class="info-grid">

    <div class="info-card info-card-wide">

      <div class="info-label">
        Address Variations
      </div>

      <div class="info-value">

        ${addressVariationsHtml}

      </div>

    </div>

    <div class="info-card info-card-wide">

      <div class="info-label">
        PAN Variations
      </div>

      <div class="info-value">

        ${panVariationsHtml}

      </div>

    </div>

  </div>

</div>

<!-- ============================================================
     DISCLAIMER
============================================================ -->

<div class="disclaimer">

  <strong>
    Important Information:
  </strong>

  This credit information report has been
  generated based on the information received
  from the CRIF credit information source
  through the authorized API integration.

  The information contained in this report
  should be reviewed carefully and may be
  subject to updates, corrections or changes
  based on subsequent reporting by the
  respective credit institutions.

</div>

</body>

</html>
`;

  // ============================================================
  // 16. CREATE DIRECTORY
  // ============================================================

  const uploadDir = path.join(
    process.cwd(),
    "uploads",
    "credit-reports",
    "crif",
  );

  fs.mkdirSync(uploadDir, {
    recursive: true,
  });

  // ============================================================
  // 17. FILE PATH
  // ============================================================

  const safeCreditReportId = String(creditReportId || Date.now()).replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );

  const fileName = `crif-${safeCreditReportId}.pdf`;

  const filePath = path.join(uploadDir, fileName);

  // ============================================================
  // 18. PUPPETEER
  // ============================================================

  let browser;

  try {
    browser = await puppeteer.launch({
      headless: true,

      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();

    await page.setViewport({
      width: 1240,
      height: 1754,
      deviceScaleFactor: 1,
    });

    await page.setContent(html, {
      waitUntil: "networkidle0",
    });

    await page.pdf({
      path: filePath,

      format: "A4",

      printBackground: true,

      preferCSSPageSize: true,

      displayHeaderFooter: true,

      headerTemplate: `
        <div
          style="
            width:100%;
            font-size:7px;
            color:#8a9baa;
            text-align:right;
            padding:0 12mm;
            font-family:Arial,Helvetica,sans-serif;
          "
        >
          CRIF Credit Information Report
        </div>
      `,

      footerTemplate: `
        <div
          style="
            width:100%;
            font-size:7px;
            color:#8a9baa;
            text-align:center;
            padding:0 12mm;
            font-family:Arial,Helvetica,sans-serif;
          "
        >
          Page
          <span class="pageNumber"></span>
          of
          <span class="totalPages"></span>
        </div>
      `,

      margin: {
        top: "14mm",
        right: "12mm",
        bottom: "18mm",
        left: "12mm",
      },
    });

    // ==========================================================
    // 19. VERIFY PDF
    // ==========================================================

    if (!fs.existsSync(filePath)) {
      throw new Error("CRIF PDF was not created");
    }

    const stats = fs.statSync(filePath);

    if (stats.size === 0) {
      throw new Error("CRIF PDF was created but file is empty");
    }

    console.log("[CRIF] PDF generated successfully:", filePath);

    console.log("[CRIF] PDF size:", stats.size, "bytes");

    return filePath;
  } catch (error) {
    console.error("[CRIF] PDF generation failed:", error);

    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (removeError) {
        console.error(
          "[CRIF] Failed to remove incomplete PDF:",
          removeError.message,
        );
      }
    }

    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error("[CRIF] Browser close error:", closeError.message);
      }
    }
  }
};

module.exports = generateCrifPdf;
