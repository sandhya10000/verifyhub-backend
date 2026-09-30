const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const { buildCibilReportHtml } = require("../templates/cibilReport.template");

// ============================================================
// GET TRUE LINK CREDIT REPORT
// ============================================================

const getTrueLinkCreditReport = (apiResponse) => {
  return (
    apiResponse?.data?.cibilData?.GetCustomerAssetsResponse
      ?.GetCustomerAssetsSuccess?.Asset?.TrueLinkCreditReport || null
  );
};

// ============================================================
// NORMALIZE EMPTY VALUES
// ============================================================

const cleanValue = (value, fallback = "-") => {
  if (value === null || value === undefined || value === "" || value === "-1") {
    return fallback;
  }

  return value;
};

// ============================================================
// DATE
// ============================================================

const normalizeDate = (value) => {
  if (!value) return "-";

  return String(value);
};

// ============================================================
// MASK ACCOUNT NUMBER
// ============================================================

const maskAccountNumber = (value) => {
  if (!value || value === "-1") {
    return "-";
  }

  const str = String(value);

  if (str.length <= 4) {
    return str;
  }

  return `${"*".repeat(str.length - 4)}${str.slice(-4)}`;
};

// ============================================================
// NUMBER
// ============================================================

const toNumber = (value) => {
  if (value === null || value === undefined || value === "" || value === "-1") {
    return 0;
  }

  const number = Number(value);

  return Number.isNaN(number) ? 0 : number;
};

// ============================================================
// PAYMENT HISTORY
// ============================================================

const normalizePaymentHistory = (history) => {
  if (!history || !Array.isArray(history.MonthlyPayStatus)) {
    return [];
  }

  return history.MonthlyPayStatus.map((item) => ({
    date: item?.date || "-",
    status:
      item?.status !== undefined && item?.status !== null ? item.status : "-",
  }));
};

// ============================================================
// EXTRACT BORROWER NAME
// ============================================================

const extractBorrowerName = (borrower) => {
  const name = borrower?.BorrowerName?.Name || {};

  const firstName = name.Forename || name.FirstName || "-";

  const lastName = name.Surname || name.LastName || "-";

  const middleName = name.MiddleName || "";

  const fullName = [firstName, middleName, lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    firstName,
    middleName,
    lastName,
    fullName: fullName || "-",
  };
};

// ============================================================
// EMAILS
// ============================================================

const extractEmails = (borrower) => {
  if (!Array.isArray(borrower?.EmailAddress)) {
    return [];
  }

  return [
    ...new Set(
      borrower.EmailAddress.map((item) => {
        if (typeof item === "string") {
          return item;
        }

        return item?.Email || item?.email || item?.EmailAddress || null;
      }).filter(Boolean),
    ),
  ];
};

// ============================================================
// PHONES
// ============================================================

const extractPhones = (borrower) => {
  if (!Array.isArray(borrower?.BorrowerTelephone)) {
    return [];
  }

  return [
    ...new Set(
      borrower.BorrowerTelephone.map((item) => {
        if (typeof item === "string") {
          return item;
        }

        return (
          item?.PhoneNumber?.Number ||
          item?.PhoneNumber ||
          item?.Number ||
          item?.telephone ||
          null
        );
      }).filter(Boolean),
    ),
  ];
};

// ============================================================
// ADDRESSES
// ============================================================

const extractAddresses = (borrower) => {
  if (!Array.isArray(borrower?.BorrowerAddress)) {
    return [];
  }

  return borrower.BorrowerAddress.map((item) => {
    const address = item?.CreditAddress || {};

    return {
      address: address.StreetAddress || "-",

      city: address.City || "-",

      state: address.Region || "-",

      pincode: address.PostalCode || "-",

      reportedDate: item?.dateReported || "-",

      origin: item?.Origin?.symbol || "-",
    };
  });
};

// ============================================================
// IDENTIFIERS
// ============================================================

const extractIdentifiers = (borrower) => {
  const identifierPartition = borrower?.IdentifierPartition;

  if (!identifierPartition) {
    return [];
  }

  let identifiers = identifierPartition.Identifier;

  if (!Array.isArray(identifiers)) {
    if (identifiers) {
      identifiers = [identifiers];
    } else {
      return [];
    }
  }

  return identifiers.map((item) => ({
    type:
      item?.IdentifierType?.description ||
      item?.IdentifierType?.symbol ||
      item?.type ||
      item?.symbol ||
      "-",

    value: item?.IdentifierValue || item?.value || item?.id || "-",
  }));
};

// ============================================================
// EMPLOYMENT
// ============================================================

const extractEmployment = (borrower) => {
  const employer = borrower?.Employer || borrower?.Employment || {};

  return {
    employer:
      employer?.name || employer?.EmployerName || employer?.CompanyName || "-",

    occupation:
      employer?.OccupationCode?.description ||
      employer?.OccupationCode?.symbol ||
      employer?.occupation ||
      "-",

    dateReported: employer?.dateReported || "-",
  };
};

// ============================================================
// ACCOUNT TYPE
// ============================================================

const getAccountType = (partition, grantedTrade) => {
  return (
    partition?.accountTypeDescription ||
    grantedTrade?.AccountType?.description ||
    partition?.accountTypeSymbol ||
    grantedTrade?.AccountType?.symbol ||
    "-"
  );
};

// ============================================================
// ACCOUNT STATUS
// ============================================================

const getAccountStatus = (tradeline) => {
  return (
    tradeline?.OpenClosed?.description ||
    tradeline?.OpenClosed?.symbol ||
    tradeline?.AccountCondition?.description ||
    tradeline?.AccountCondition?.symbol ||
    "-"
  );
};

// ============================================================
// EXTRACT ACCOUNTS
// ============================================================

const extractAccounts = (report) => {
  const partitions = Array.isArray(report?.TradeLinePartition)
    ? report.TradeLinePartition
    : [];

  const accounts = [];

  partitions.forEach((partition) => {
    const tradeline = partition?.Tradeline;

    if (!tradeline) {
      return;
    }

    const grantedTrade = tradeline?.GrantedTrade || {};

    accounts.push({
      // --------------------------------------------------------
      // BASIC ACCOUNT DETAILS
      // --------------------------------------------------------

      creditorName: tradeline?.creditorName || "-",

      accountNumber: maskAccountNumber(tradeline?.accountNumber),

      rawAccountNumber: tradeline?.accountNumber || "-",

      accountType: getAccountType(partition, grantedTrade),

      accountTypeCode:
        partition?.accountTypeSymbol ||
        grantedTrade?.AccountType?.symbol ||
        "-",

      // --------------------------------------------------------
      // DATES
      // --------------------------------------------------------

      dateOpened: normalizeDate(tradeline?.dateOpened),

      dateClosed: normalizeDate(tradeline?.dateClosed),

      dateReported: normalizeDate(tradeline?.dateReported),

      dateAccountStatus: normalizeDate(tradeline?.dateAccountStatus),

      // --------------------------------------------------------
      // AMOUNTS
      // --------------------------------------------------------

      currentBalance: cleanValue(tradeline?.currentBalance),

      highBalance: cleanValue(tradeline?.highBalance),

      amountPastDue: cleanValue(grantedTrade?.amountPastDue),

      creditLimit: cleanValue(grantedTrade?.CreditLimit),

      cashLimit: cleanValue(grantedTrade?.CashLimit),

      interestRate: cleanValue(grantedTrade?.interestRate),

      emi: cleanValue(grantedTrade?.EMIAmount),

      repaymentTenure: cleanValue(grantedTrade?.termMonths),

      dateLastPayment: normalizeDate(grantedTrade?.dateLastPayment),

      // --------------------------------------------------------
      // WRITE OFF / SETTLEMENT
      // --------------------------------------------------------

      writtenOff: cleanValue(tradeline?.writtenOffAmtTotal),

      writtenOffPrincipal: cleanValue(tradeline?.writtenOffPrincipal),

      settlementAmount: cleanValue(tradeline?.settlementAmount),

      // --------------------------------------------------------
      // PAYMENT / COLLATERAL
      // --------------------------------------------------------

      actualPaymentAmount: cleanValue(grantedTrade?.actualPaymentAmount),

      collateral: cleanValue(grantedTrade?.collateral),

      collateralType:
        grantedTrade?.CollateralType?.description ||
        grantedTrade?.CollateralType?.symbol ||
        "-",

      paymentFrequency:
        grantedTrade?.PaymentFrequency?.description ||
        grantedTrade?.PaymentFrequency?.symbol ||
        "-",

      creditType:
        grantedTrade?.CreditType?.description ||
        grantedTrade?.CreditType?.symbol ||
        "-",

      // --------------------------------------------------------
      // STATUS
      // --------------------------------------------------------

      status: getAccountStatus(tradeline),

      // --------------------------------------------------------
      // PAYMENT HISTORY
      // --------------------------------------------------------

      paymentHistory: normalizePaymentHistory(grantedTrade?.PayStatusHistory),
    });
  });

  return accounts;
};

// ============================================================
// EXTRACT INQUIRIES
// ============================================================

const extractInquiries = (report) => {
  const partitions = Array.isArray(report?.InquiryPartition)
    ? report.InquiryPartition
    : [];

  const inquiries = [];

  partitions.forEach((partition) => {
    const inquiry = partition?.Inquiry;

    if (!inquiry) {
      return;
    }

    inquiries.push({
      subscriberName:
        inquiry?.subscriberName ||
        inquiry?.memberName ||
        inquiry?.MemberName ||
        "-",

      inquiryDate: inquiry?.inquiryDate || inquiry?.date || "-",

      inquiryType: inquiry?.inquiryType || "-",

      amount: cleanValue(inquiry?.amount),

      controlNumber: inquiry?.enqControlNum || "-",

      description: inquiry?.description || "-",

      subscriberNumber: inquiry?.subscriberNumber || "-",
    });
  });

  return inquiries;
};

// ============================================================
// ACCOUNT SUMMARY
// ============================================================

const calculateSummary = (accounts) => {
  let totalCurrentBalance = 0;
  let totalHighBalance = 0;
  let totalPastDue = 0;

  let activeAccounts = 0;
  let closedAccounts = 0;

  accounts.forEach((account) => {
    totalCurrentBalance += toNumber(account.currentBalance);

    totalHighBalance += toNumber(account.highBalance);

    totalPastDue += toNumber(account.amountPastDue);

    const closed =
      account.dateClosed &&
      account.dateClosed !== "-" &&
      account.dateClosed !== "";

    if (closed) {
      closedAccounts++;
    } else {
      activeAccounts++;
    }
  });

  return {
    totalAccounts: accounts.length,

    activeAccounts,

    closedAccounts,

    totalCurrentBalance,

    totalHighBalance,

    totalPastDue,
  };
};

// ============================================================
// PREPARE PDF DATA
// ============================================================

const prepareCibilPdfData = (apiResponse, creditReportId) => {
  const report = getTrueLinkCreditReport(apiResponse);

  if (!report) {
    throw new Error("TrueLinkCreditReport not found in CIBIL API response");
  }

  const borrower = report?.Borrower || {};

  const name = extractBorrowerName(borrower);

  const emails = extractEmails(borrower);

  const phones = extractPhones(borrower);

  const addresses = extractAddresses(borrower);

  const identifiers = extractIdentifiers(borrower);

  const employment = extractEmployment(borrower);

  const accounts = extractAccounts(report);

  const inquiries = extractInquiries(report);

  const score = borrower?.CreditScore || {};

  // ----------------------------------------------------------
  // GENDER
  // ----------------------------------------------------------

  let gender = "-";

  if (typeof borrower?.Gender === "string") {
    gender = borrower.Gender;
  } else if (borrower?.Gender?.description) {
    gender = borrower.Gender.description;
  } else if (borrower?.Gender?.symbol) {
    gender = borrower.Gender.symbol;
  }

  // ----------------------------------------------------------
  // RETURN NORMALIZED DATA
  // ----------------------------------------------------------

  return {
    creditReportId,

    referenceKey: report?.ReferenceKey || "-",

    reportVersion: report?.currentversion || "-",

    generatedAt: new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    }),

    borrower: {
      borrowerKey: borrower?.borrowerKey || "-",

      ...name,

      dob: borrower?.Birth?.date || "-",

      gender,

      emails,

      phones,

      addresses,

      identifiers,
    },

    score: {
      value: score?.riskScore || "-",

      model:
        score?.CreditScoreModel?.description ||
        score?.CreditScoreModel?.symbol ||
        "-",

      scoreName: score?.scoreName || "-",

      populationRank: score?.populationRank || "-",
    },

    employment,

    accounts,

    inquiries,

    summary: calculateSummary(accounts),

    bureauStatus: {
      safetyCheckPassed: report?.SafetyCheckPassed,

      frozen: report?.Frozen,

      deceased: report?.DeceasedIndicator,

      fraud: report?.FraudIndicator,
    },
  };
};

// ============================================================
// GENERATE PDF
// ============================================================

const generateCibilPdf = async (apiResponse, creditReportId) => {
  let browser;

  try {
    console.log("[CIBIL PDF] Preparing report data...");

    // --------------------------------------------------------
    // PREPARE DATA
    // --------------------------------------------------------

    const pdfData = prepareCibilPdfData(apiResponse, creditReportId);

    console.log("[CIBIL PDF] Accounts:", pdfData.accounts.length);

    console.log("[CIBIL PDF] Inquiries:", pdfData.inquiries.length);

    // --------------------------------------------------------
    // BUILD HTML
    // --------------------------------------------------------

    const html = buildCibilReportHtml(pdfData);

    // --------------------------------------------------------
    // CIBIL PDF FOLDER
    // --------------------------------------------------------

    const uploadDir = path.join(
      process.cwd(),
      "uploads",
      "credit-reports",
      "cibil",
    );

    // --------------------------------------------------------
    // CREATE FOLDER IF NOT EXISTS
    // --------------------------------------------------------

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, {
        recursive: true,
      });
    }

    // --------------------------------------------------------
    // FILE NAME
    // --------------------------------------------------------

    const fileName = `cibil-report-${creditReportId}-${Date.now()}.pdf`;

    const filePath = path.join(uploadDir, fileName);

    console.log("[CIBIL PDF] File path:", filePath);

    // --------------------------------------------------------
    // LAUNCH PUPPETEER
    // --------------------------------------------------------

    console.log("[CIBIL PDF] Launching browser...");

    browser = await puppeteer.launch({
      headless: true,

      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    // --------------------------------------------------------
    // NEW PAGE
    // --------------------------------------------------------

    const page = await browser.newPage();

    // --------------------------------------------------------
    // VIEWPORT
    // --------------------------------------------------------

    await page.setViewport({
      width: 1280,
      height: 1800,
      deviceScaleFactor: 1,
    });

    // --------------------------------------------------------
    // LOAD HTML
    // --------------------------------------------------------

    await page.setContent(html, {
      waitUntil: "networkidle0",
    });

    // --------------------------------------------------------
    // WAIT FOR FONTS
    // --------------------------------------------------------

    await page.evaluate(async () => {
      if (document.fonts) {
        await document.fonts.ready;
      }
    });

    console.log("[CIBIL PDF] Generating PDF...");

    // --------------------------------------------------------
    // GENERATE PDF
    // --------------------------------------------------------

    await page.pdf({
      path: filePath,

      format: "A4",

      printBackground: true,

      preferCSSPageSize: true,

      displayHeaderFooter: true,

      headerTemplate: `
        <div
          style="
            width: 100%;
            font-size: 8px;
            padding: 0 25px;
            color: #777;
            font-family: Arial, sans-serif;
          "
        >
          CIBIL Credit Information Report
        </div>
      `,

      footerTemplate: `
        <div
          style="
            width: 100%;
            font-size: 8px;
            padding: 0 25px;
            color: #777;
            text-align: center;
            font-family: Arial, sans-serif;
          "
        >
          Page
          <span class="pageNumber"></span>
          of
          <span class="totalPages"></span>
        </div>
      `,

      margin: {
        top: "45px",
        bottom: "45px",
        left: "25px",
        right: "25px",
      },
    });

    // --------------------------------------------------------
    // CLOSE BROWSER
    // --------------------------------------------------------

    await browser.close();

    browser = null;

    console.log("[CIBIL PDF] PDF generated:", filePath);

    // --------------------------------------------------------
    // RETURN
    // --------------------------------------------------------

    return {
      success: true,

      fileName,

      filePath,

      // IMPORTANT:
      // CIBIL folder URL
      relativePath: `/uploads/credit-reports/cibil/${fileName}`,

      // Same URL as relativePath
      pdfUrl: `/uploads/credit-reports/cibil/${fileName}`,

      data: pdfData,
    };
  } catch (error) {
    console.error("[CIBIL PDF] Generation error:", error);

    // --------------------------------------------------------
    // CLOSE BROWSER ON ERROR
    // --------------------------------------------------------

    if (browser) {
      await browser.close();
    }

    throw error;
  }
};

// ============================================================
// EXPORT
// ============================================================

module.exports = {
  generateCibilPdf,
  prepareCibilPdfData,
  getTrueLinkCreditReport,
};
