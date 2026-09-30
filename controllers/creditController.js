const axios = require("axios");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const CreditReport = require("../models/creditReport");
const User = require("../models/User");
const config = require("../config/bureau.config");

const SUREPASS_CONFIG = require("../config/surepass");
const saveCreditReportLocally = require("../utils/saveCreditReportLocally");
const generateExperianPdf = require("../services/experianPdf.service");
const generateCrifPdf = require("../templates/generateCrifPdf");
const { getSurepassApiKeyValue } = require("../utils/surepassKey");
// Models

const Setting = require("../models/Setting");

// Surepass client
const surepassClient = require("../services/surepassClient");

const {
  canAfford,
  chargeForReport,
  chargeFailedReport,
} = require("../utils/wallet");
const { generateCibilPdf } = require("../services/cibilPdf.service");

// CIBIL score extractor — mirrors the path the PDF service already uses
// (TrueLinkCreditReport.Borrower.CreditScore.riskScore), with fallbacks for
// legacy flat shapes. Returns a Number in CIBIL range or null.
// NOTE: the old code read cibilData.score / cibilData.cibilScore, keys Digi
// never sends — every CIBIL row saved score: null because of it.
const extractCibilScore = (apiData) => {
  const cibilData = apiData?.data?.cibilData;
  console.log(cibilData,"CIBIL")
  if (!cibilData) return null;
  const candidates = [
    cibilData?.GetCustomerAssetsResponse?.GetCustomerAssetsSuccess?.Asset
      ?.TrueLinkCreditReport?.Borrower?.CreditScore?.riskScore,
    cibilData?.TrueLinkCreditReport?.Borrower?.CreditScore?.riskScore,
    cibilData?.Borrower?.CreditScore?.riskScore,
    cibilData?.score,
    cibilData?.cibilScore,
    cibilData?.creditScore,
  ];
  for (const raw of candidates) {
    if (raw === null || raw === undefined || raw === "" || raw === "-") continue;
    const n = Number(raw);
    if (!Number.isNaN(n) && n >= 300 && n <= 900) return n;
  }
  return null;
};

// Wallet affordability gate — run after input validation, before any paid
// bureau call. Sends 402 when the partner cannot cover one pull.
const affordOr402 = async (req, res, productKey) => {
  try {
    const gate = await canAfford(req.user?._id, productKey);
    if (!gate.ok) {
      res.status(402).json({
        success: false,
        message:
          gate.reason === "user-not-found"
            ? "User authentication required"
            : `Insufficient wallet balance. ${gate.total} required — please recharge.`,
        required: gate.total,
        balance: gate.balance,
      });
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[wallet] affordability check failed (${productKey}):`,
      err.message,
    );
    return true; // fail-open: never block delivery on a pricing hiccup
  }
};

// Post-success debit — guarded, idempotent, and never throws, so report
// delivery can never break because of a ledger problem.
const debitReportPull = async (creditReport, productKey, bureauLabel) => {
  try {
    const charge = await chargeForReport(
      creditReport.userId,
      creditReport._id,
      productKey,
      bureauLabel,
    );
    if (!charge.ok) {
      console.warn(
        `[wallet] charge skipped (${charge.reason}) for ${bureauLabel} report ${creditReport._id}`,
      );
    } else {
      console.log(
        `[wallet] charged ₹${charge.total} for ${bureauLabel} report ${creditReport._id} (balance ₹${charge.balance})`,
      );
    }
    return charge;
  } catch (err) {
    console.error(
      `[wallet] charge error for ${bureauLabel} report ${creditReport._id}:`,
      err.message,
    );
    return { ok: false, reason: "error" };
  }
};

// Post-failure debit — same guards as success. CIBIL is mismatch-gated
// (matched inputs fail free); every other product bills the flat fallback.
// Never throws; returns the charge result for response transparency.
const debitFailedPull = async (
  creditReport,
  productKey,
  bureauLabel,
  mismatched = true,
) => {
  if (!creditReport?._id || !creditReport?.userId)
    return { ok: false, reason: "no-report" };
  try {
    const charge = await chargeFailedReport(
      creditReport.userId,
      creditReport._id,
      productKey,
      bureauLabel,
      mismatched,
    );
    if (charge.free) {
      console.log(
        `[wallet] ${bureauLabel} fail free (inputs matched) for report ${creditReport._id}`,
      );
    } else if (charge.ok) {
      console.log(
        `[wallet] charged ₹${charge.total} ${bureauLabel} fail fee for report ${creditReport._id} (balance ₹${charge.balance})`,
      );
    } else {
      console.warn(
        `[wallet] ${bureauLabel} fail charge skipped (${charge.reason}) for report ${creditReport._id}`,
      );
    }
    return charge;
  } catch (err) {
    console.error(
      `[wallet] fail-charge error for ${bureauLabel} report ${creditReport._id}:`,
      err.message,
    );
    return { ok: false, reason: "error" };
  }
};
//logic for cibil report from digi
const CibilReportFromDigi = async (req, res) => {
  let creditReport = null;

  try {
    console.log("[CIBIL] Starting CIBIL V7 report generation...");

    // ============================================================
    // 1. DIGI CONFIG
    // ============================================================

    const baseUrl = process.env.DIGI_BASE_URL;
    const partnerId = process.env.DIGI_PARTNER_ID;
    const secretKey = process.env.DIGI_SECRET_KEY;

    if (!baseUrl) {
      return res.status(500).json({
        success: false,
        message: "DIGI_BASE_URL is not configured",
      });
    }

    if (!partnerId) {
      return res.status(500).json({
        success: false,
        message: "DIGI_PARTNER_ID is not configured",
      });
    }

    if (!secretKey) {
      return res.status(500).json({
        success: false,
        message: "DIGI_SECRET_KEY is not configured",
      });
    }

    // ============================================================
    // 2. REQUEST DATA
    // ============================================================

    const {
      fullname,
      firstName,
      lastName,
      mobile,
      pan,
      consent,
      creditReportId,
      orderId,
    } = req.body;

    const customerName =
      fullname || `${firstName || ""} ${lastName || ""}`.trim();

    if (!customerName) {
      return res.status(400).json({
        success: false,
        message: "Full name is required",
      });
    }

    if (!mobile) {
      return res.status(400).json({
        success: false,
        message: "Mobile number is required",
      });
    }

    if (!pan) {
      return res.status(400).json({
        success: false,
        message: "PAN number is required",
      });
    }

    if (consent !== "Y") {
      return res.status(400).json({
        success: false,
        message: "Customer consent is required",
      });
    }

    // ============================================================
    // 3. GENERATE JWT (per DigiVerification auth docs)
    // Contract: HS256 signed with the partner secret; payload MUST be
    // { timestamp (unix seconds, valid <= 5 min), partnerId, reqid (random) }.
    // Signed fresh on every request — never cached/reused.
    // ============================================================

    const cleanPartnerId = String(partnerId || "").trim();
    const cleanSecretKey = String(secretKey || "").trim();

    const jwtToken = jwt.sign(
      {
        timestamp: Math.floor(Date.now() / 1000),
        partnerId: cleanPartnerId,
        reqid: Math.floor(Math.random() * 1000000000),
      },
      cleanSecretKey,
    );

    console.log("[CIBIL] JWT generated", jwtToken);

    // ============================================================
    // 4. DIGI PAYLOAD
    // ============================================================

    const digiPayload = {
      fullname: customerName,
      mobile: mobile.toString().trim(),
      pan: pan.toString().trim().toUpperCase(),
      consent: "Y",
    };

    console.log("[CIBIL] Digi Payload:", {
      fullname: customerName,
      mobile: "********",
      pan: "********",
      consent: "Y",
    });

    // ============================================================
    // 5. CALL DIGI API
    // ============================================================

    const apiUrl = `${baseUrl.replace(/\/+$/, "")}/api/v7/cibil-bureau-report`;

    console.log("[CIBIL] Calling:", apiUrl);

    const response = await axios.post(apiUrl, digiPayload, {
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "jwt-token": jwtToken,
      },
      timeout: 120000,
    });

    const apiData = response.data;

    console.log("[CIBIL] Digi API success:", apiData?.success);

    // ============================================================
    // 6. CHECK CIBIL DATA
    // ============================================================

    const cibilData = apiData?.data?.cibilData;

    if (!cibilData) {
      return res.status(400).json({
        success: false,
        message: "CIBIL data not found in Digi API response",
        data: apiData,
      });
    }

    // ============================================================
    // 7. CREATE CREDIT REPORT IN DATABASE
    // ============================================================

    creditReport = await CreditReport.create({
      userId: req.user?._id,

      orderId: orderId || null,

      name: customerName,

      firstName: firstName || null,
      lastName: lastName || null,

      mobile: mobile.toString().trim(),

      pan: pan.toString().trim().toUpperCase(),

      reportType: "CIBIL",

      consent: "Y",

      bureau: "CIBIL",

      status: "Pending",

      reportUrl: null,

      localPath: null,

      reportData: apiData,

      score: extractCibilScore(apiData),

      isPublic: false,
    });

    console.log(
      "[CIBIL] CreditReport saved:",
      creditReport._id,
      "score:",
      creditReport.score,
    );

    // ============================================================
    // 8. GENERATE PDF USING DATABASE ID
    // ============================================================

    const pdfCreditReportId = creditReport._id.toString();

    console.log("[CIBIL] Generating PDF:", pdfCreditReportId);

    const pdf = await generateCibilPdf(apiData, pdfCreditReportId);

    if (!pdf || !pdf.filePath) {
      throw new Error("CIBIL PDF was not generated");
    }

    // ============================================================
    // 9. UPDATE DATABASE WITH PDF DETAILS
    // ============================================================

    creditReport.localPath = pdf.filePath;

    creditReport.reportUrl = pdf.relativePath;

    // Re-derive score at completion (same extractor as creation) so the
    // final Success row can never carry a stale null.
    const finalScore = extractCibilScore(apiData);
    if (finalScore !== null) creditReport.score = finalScore;

    creditReport.status = "Success";

    await creditReport.save();

    console.log("[CIBIL] CreditReport updated with PDF");

    // ============================================================
    // 10. SUCCESS RESPONSE
    // ============================================================

    return res.status(200).json({
      success: true,

      message: "CIBIL report generated successfully",

      data: {
        creditReportId: creditReport._id,

        fileName: pdf.fileName,

        pdfUrl: pdf.relativePath,

        filePath: pdf.filePath,

        bureau: "CIBIL",

        score: creditReport.score ?? null,

        status: "Success",
      },
    });
  } catch (error) {
    console.error("[CIBIL] API/PDF Error:", error.message);

    // ============================================================
    // UPDATE DB AS FAILED
    // ============================================================

    if (creditReport) {
      try {
        creditReport.status = "Failed";

        await creditReport.save();

        console.log("[CIBIL] CreditReport marked as Failed");
      } catch (dbError) {
        console.error("[CIBIL] Failed to update DB status:", dbError.message);
      }
    }

    // ============================================================
    // DIGI ERROR
    // ============================================================

    if (error.response) {
      console.error("[CIBIL] Digi API status:", error.response.status);

      console.error("[CIBIL] Digi API response:", error.response.data);
    }

    // Provider auth failures (bad/rotated secret, IP/geo block, inactive
    // product) surface as Digi 401s. Don't leak raw provider strings
    // (which embed server IPs) to the UI — full body stays server-side above.
    const digiStatus = error.response?.status;
    const isDigiAuthFailure =
      digiStatus === 401 ||
      /authentication failed/i.test(
        String(error.response?.data?.message || ""),
      );

    return res.status(digiStatus || 500).json({
      success: false,

      message: isDigiAuthFailure
        ? "Bureau authentication failed. Please contact support."
        : error.response?.data?.message || "Failed to generate CIBIL report",

      error: error.response?.data || error.message,
    });
  }
};

const CrifReport = async (req, res) => {
  let creditReport = null;

  try {
    const {
      panNumber,
      fullName,
      mobileNumber,
      email,
      dob,
      pincode,
      stateName,
      cityName,
      addressLine1,
      addressLine2,
      customerConsent,
      userAns,
      reportId,
      orderId,
    } = req.body;

    // ============================================================
    // STEP 1: AUTHENTICATED USER
    // ============================================================

    const userId = req.user?._id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User authentication required",
      });
    }

    console.log("[CRIF] Authenticated User:", userId);

    // ============================================================
    // STEP 2: ENV CONFIG
    // ============================================================

    const baseUrl = process.env.INDICONNECT_BASE_URL;
    const accessKey = process.env.INDICONNECT_ACCESS_KEY;
    const secretKey = process.env.INDICONNECT_SECRET_KEY;
    const serviceKey = process.env.INDICONNECT_SERVICE_KEY;

    const crifEndpoint =
      process.env.INDICONNECT_CRIF_ENDPOINT || "/crifService/crif/score";

    const timeout = 60000;

    // ============================================================
    // STEP 3: CONFIG VALIDATION
    // ============================================================

    if (!baseUrl || !accessKey || !secretKey || !serviceKey) {
      console.error("[CRIF] Missing environment variables");

      return res.status(500).json({
        success: false,
        message: "CRIF API credentials are not configured",
      });
    }

    // ============================================================
    // STEP 4: HEADERS
    // ============================================================

    const headers = {
      Authorization: `x-api-access ${secretKey}:${accessKey}`,
      "service-key": serviceKey,
      "Content-Type": "application/json",
    };

    // ============================================================
    // STEP 5: API URL
    // ============================================================

    const apiUrl =
      `${baseUrl.replace(/\/$/, "")}/` + `${crifEndpoint.replace(/^\//, "")}`;

    console.log("[CRIF] API URL:", apiUrl);

    // ============================================================
    // STEP 6: Q&A FLOW
    // ============================================================

    const isQuestionRequest = userAns !== undefined || reportId !== undefined;

    if (isQuestionRequest) {
      if (
        userAns === undefined ||
        userAns === null ||
        String(userAns).trim() === "" ||
        !reportId ||
        !orderId
      ) {
        return res.status(400).json({
          success: false,
          message:
            "userAns, reportId and orderId are required for CRIF question answer",
        });
      }

      const qaPayload = {
        userAns: String(userAns).trim(),
        reportId: String(reportId).trim(),
        orderId: String(orderId).trim(),
      };

      // Find report only for logged-in user
      creditReport = await CreditReport.findOne({
        userId,
        reportId: qaPayload.reportId,
        orderId: qaPayload.orderId,
        bureau: "CRIF",
      });

      if (!creditReport) {
        return res.status(404).json({
          success: false,
          message: "CRIF report record not found for this user",
        });
      }

      // Call CRIF API
      const response = await axios.post(apiUrl, qaPayload, {
        headers,
        timeout,
      });

      const apiData = response.data;

      console.log("[CRIF] Q&A Response:", JSON.stringify(apiData, null, 2));

      // Report URL
      const reportUrl =
        apiData.reportUrl ||
        apiData.pdfUrl ||
        apiData.data?.reportUrl ||
        apiData.data?.pdfUrl ||
        null;

      let localPath = creditReport.localPath || null;

      // Save locally
      if (reportUrl && !localPath) {
        try {
          localPath = await saveCreditReportLocally(
            reportUrl,
            creditReport._id.toString(),
            "crif",
            "pdf",
          );

          console.log("[CRIF] Q&A Report saved locally:", localPath);
        } catch (fileError) {
          console.error("[CRIF] Q&A Local Save Error:", fileError.message);
        }
      }

      // Score
      let score = creditReport.score;

      if (
        apiData.score !== undefined &&
        apiData.score !== null &&
        apiData.score !== ""
      ) {
        const parsedScore = Number(apiData.score);

        if (!Number.isNaN(parsedScore)) {
          score = parsedScore;
        }
      }

      // Update
      creditReport.reportUrl = reportUrl || creditReport.reportUrl;

      creditReport.localPath = localPath;
      creditReport.reportData = apiData;
      creditReport.score = score;
      creditReport.status = "Success";

      await creditReport.save();

      // Wallet debit (CRIF = ₹50 + GST) — idempotent per report, so the
      // Q&A completion and the fresh pull can never double-charge
      await debitReportPull(creditReport, "crif", "CRIF");

      return res.status(200).json({
        success: true,
        status: "success",
        message: "CRIF report fetched successfully",

        creditReportId: creditReport._id,
        userId: creditReport.userId,
        reportId: creditReport.reportId,
        orderId: creditReport.orderId,

        score: creditReport.score,

        reportUrl: creditReport.reportUrl,
        localPath: creditReport.localPath,

        data: creditReport,
      });
    }

    // ============================================================
    // STEP 7: INITIAL VALIDATION
    // ============================================================

    const requiredFields = {
      panNumber,
      fullName,
      mobileNumber,
      email,
      dob,
      pincode,
      stateName,
      cityName,
      addressLine1,
      addressLine2,
      customerConsent,
    };

    const missingFields = Object.entries(requiredFields)
      .filter(
        ([, value]) =>
          value === undefined || value === null || String(value).trim() === "",
      )
      .map(([key]) => key);

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Required CRIF fields are missing",
        missingFields,
      });
    }

    // ============================================================
    // STEP 8: CONSENT
    // ============================================================

    if (String(customerConsent).trim().toUpperCase() !== "Y") {
      return res.status(400).json({
        success: false,
        message: "Customer consent must be Y",
      });
    }

    // Wallet gate (CRIF = ₹50 + GST) — fresh pulls only; Q&A answers
    // reuse the already-gated report above
    if (!(await affordOr402(req, res, "crif"))) return;

    // ============================================================
    // STEP 9: DOB
    // ============================================================

    const dobValue = String(dob).trim();

    const dobRegex = /^\d{4}-\d{2}-\d{2}$/;

    if (!dobRegex.test(dobValue)) {
      return res.status(400).json({
        success: false,
        message: "DOB must be in YYYY-MM-DD format",
      });
    }

    // ============================================================
    // STEP 10: PAYLOAD
    // ============================================================

    const payload = {
      panNumber: String(panNumber).trim().toUpperCase(),

      fullName: String(fullName).trim(),

      mobileNumber: String(mobileNumber).trim(),

      email: String(email).trim(),

      dob: dobValue,

      pincode: String(pincode).trim(),

      stateName: String(stateName).trim(),

      cityName: String(cityName).trim(),

      addressLine1: String(addressLine1).trim(),

      addressLine2: String(addressLine2).trim(),

      customerConsent: "Y",
    };
    // ============================================================
    // STEP 10.1: DUPLICATE PAN CHECK
    // ============================================================

    const normalizedPan = String(panNumber).trim().toUpperCase();

    const existingReport = await CreditReport.findOne({
      userId,
      pan: normalizedPan,
      bureau: "CRIF",
      status: "Success",
    });

    if (existingReport) {
      console.log("[CRIF] Duplicate PAN request blocked:", normalizedPan);

      return res.status(409).json({
        success: false,
        status: "duplicate",
        message: "A CRIF credit report already exists for this PAN.",

        creditReportId: existingReport._id,

        userId: existingReport.userId,

        reportId: existingReport.reportId,

        orderId: existingReport.orderId,

        score: existingReport.score,

        reportUrl: existingReport.reportUrl,

        localPath: existingReport.localPath,

        data: existingReport,
      });
    }

    // ============================================================
    // STEP 11: CREATE PENDING REPORT
    // ============================================================

    creditReport = await CreditReport.create({
      userId,

      orderId: orderId ? String(orderId).trim() : null,

      name: String(fullName).trim(),

      mobile: String(mobileNumber).trim(),

      pan: String(panNumber).trim().toUpperCase(),

      reportType: "CRIF",

      consent: "Y",

      bureau: "CRIF",

      status: "Pending",

      reportUrl: null,

      localPath: null,

      reportData: null,

      isPublic: false,
    });

    console.log("[CRIF] Pending Report Created:", creditReport._id);

    // ============================================================
    // STEP 12: CALL CRIF API
    // ============================================================

    const response = await axios.post(apiUrl, payload, {
      headers,
      timeout,
    });

    const apiData = response.data;

    console.log("[CRIF] Initial Response:", JSON.stringify(apiData, null, 2));

    // ============================================================
    // STEP 13: API FAILURE
    // ============================================================

    if (apiData?.status === false || apiData?.success === false) {
      creditReport.status = "Failed";

      creditReport.reportData = apiData;

      await creditReport.save();

      // Definitive bureau rejection — flat ₹30 fail fee
      const crifFailCharge = await debitFailedPull(
        creditReport,
        "crif",
        "CRIF",
      );
      return res.status(400).json({
        success: false,
        message: apiData?.message || "CRIF report request failed",

        creditReportId: creditReport._id,

        status: creditReport.status,

        data: apiData,

        failureCharge: crifFailCharge.ok ? crifFailCharge.total : 0,
      });
    }

    // ============================================================
    // STEP 14: REPORT ID
    // ============================================================

    const crifReportId =
      apiData.reportId ||
      apiData.reportID ||
      apiData.data?.reportId ||
      apiData.data?.reportID ||
      null;

    // ============================================================
    // STEP 15: SCORE
    // ============================================================

    let score = null;

    if (
      apiData?.data?.score !== undefined &&
      apiData?.data?.score !== null &&
      apiData?.data?.score !== ""
    ) {
      const parsedScore = Number(apiData.data.score);

      if (!Number.isNaN(parsedScore)) {
        score = parsedScore;
      }
    }

    // ============================================================
    // STEP 16: REPORT URL
    // ============================================================

    const reportUrl =
      apiData.reportUrl ||
      apiData.pdfUrl ||
      apiData.data?.reportUrl ||
      apiData.data?.pdfUrl ||
      null;

    // ============================================================
    // STEP 17: GENERATE PDF FROM JSON RESPONSE
    // ============================================================

    let localPath = null;

    try {
      localPath = await generateCrifPdf(apiData, creditReport._id.toString());

      console.log("[CRIF] PDF generated successfully:", localPath);
    } catch (pdfError) {
      console.error("[CRIF] PDF generation failed:", pdfError.message);
    }

    // ============================================================
    // STEP 18: UPDATE DATABASE
    // ============================================================

    creditReport.reportId = crifReportId;

    creditReport.score = score;

    creditReport.reportUrl = reportUrl;

    const pdfUrl = localPath
      ? `/uploads/credit-reports/crif/crif-${creditReport._id}.pdf`
      : null;

    creditReport.localPath = pdfUrl;

    creditReport.reportData = apiData;

    creditReport.status = "Success";

    await creditReport.save();

    // Wallet debit (CRIF = ₹50 + GST) — post-success only
    await debitReportPull(creditReport, "crif", "CRIF");

    // ============================================================
    // STEP 19: RESPONSE
    // ============================================================

    return res.status(200).json({
      success: true,

      status: "success",

      message: "CRIF report fetched successfully",

      creditReportId: creditReport._id,

      userId: creditReport.userId,

      reportId: creditReport.reportId,

      orderId: creditReport.orderId,

      score: creditReport.score,

      reportUrl: creditReport.reportUrl,

      localPath: creditReport.localPath,

      data: creditReport,
    });
  } catch (error) {
    console.error("[CRIF] Error:", error.message);

    // ============================================================
    // UPDATE FAILED REPORT
    // ============================================================

    if (creditReport) {
      try {
        creditReport.status = "Failed";

        creditReport.reportData = {
          error: error.response?.data || error.message,
        };

        await creditReport.save();
      } catch (dbError) {
        console.error(
          "[CRIF] Failed to update report status:",
          dbError.message,
        );
      }
    }

    // ============================================================
    // AXIOS ERROR
    // ============================================================

    if (error.response) {
      console.error("[CRIF] HTTP STATUS:", error.response.status);

      console.error(
        "[CRIF] API ERROR:",
        JSON.stringify(error.response.data, null, 2),
      );

      // Bureau answered with an error — flat ₹30 fail fee (no-response /
      // internal errors below stay free)
      const crifErrCharge = await debitFailedPull(creditReport, "crif", "CRIF");
      return res.status(error.response.status || 500).json({
        success: false,

        status: "failed",

        message: "CRIF API request failed",

        creditReportId: creditReport?._id || null,

        error: error.response.data,

        failureCharge: crifErrCharge.ok ? crifErrCharge.total : 0,
      });
    }

    // ============================================================
    // NO RESPONSE
    // ============================================================

    if (error.request) {
      return res.status(504).json({
        success: false,

        status: "failed",

        message: "CRIF API did not respond",

        creditReportId: creditReport?._id || null,
      });
    }

    // ============================================================
    // INTERNAL ERROR
    // ============================================================

    return res.status(500).json({
      success: false,

      status: "failed",

      message: "Internal server error",

      creditReportId: creditReport?._id || null,

      error: error.message,
    });
  }
};

const ExperianReport = async (req, res) => {
  let creditReport = null;

  try {
    const {
      panNumber,
      fullName,
      mobileNumber,
      email,
      dob,
      pincode,
      stateName,
      cityName,
      addressLine1,
      addressLine2,
      customerConsent,
      orderId,
    } = req.body;

    // ============================================================
    // 1. AUTHENTICATED USER
    // ============================================================

    const userId = req.user?._id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User authentication required",
      });
    }

    console.log("[EXPERIAN] Authenticated User:", userId);

    // ============================================================
    // 2. VALIDATION
    // ============================================================

    const requiredFields = {
      panNumber,
      fullName,
      mobileNumber,
      email,
      dob,
      pincode,
      stateName,
      cityName,
      addressLine1,
      addressLine2,
      customerConsent,
    };

    const missingFields = Object.entries(requiredFields)
      .filter(
        ([, value]) =>
          value === undefined || value === null || String(value).trim() === "",
      )
      .map(([key]) => key);

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Required fields are missing",
        missingFields,
      });
    }

    // ============================================================
    // 3. CONSENT
    // ============================================================

    if (String(customerConsent).trim().toUpperCase() !== "Y") {
      return res.status(400).json({
        success: false,
        message: "Customer consent must be Y",
      });
    }

    // ============================================================
    // 3A. DUPLICATE PAN CHECK
    // ============================================================

    const normalizedPan = String(panNumber).trim().toUpperCase();

    const existingReport = await CreditReport.findOne({
      userId,
      pan: normalizedPan,
      bureau: "EXPERIAN",
      status: {
        $in: ["Pending", "Success"],
      },
    }).sort({ createdAt: -1 });

    if (existingReport) {
      // ----------------------------------------------------------
      // If previous request is still processing
      // ----------------------------------------------------------
      if (existingReport.status === "Pending") {
        return res.status(409).json({
          success: false,
          status: "duplicate_pending",
          message:
            "An Experian credit report request for this PAN is already in progress.",
          creditReportId: existingReport._id,
          userId: existingReport.userId,
          status: existingReport.status,
        });
      }

      // ----------------------------------------------------------
      // If report already exists successfully
      // ----------------------------------------------------------
      return res.status(409).json({
        success: false,
        status: "duplicate",
        message: "An Experian credit report already exists for this PAN.",
        creditReportId: existingReport._id,
        userId: existingReport.userId,
        score: existingReport.score,
        status: existingReport.status,
        reportUrl: existingReport.reportUrl,
        localPath: existingReport.localPath,
        data: existingReport,
      });
    }

    // ============================================================
    // 3B. WALLET GATE
    // ============================================================

    // Wallet gate (Experian = ₹50 + GST)
    if (!(await affordOr402(req, res, "experian"))) return;

    // ============================================================
    // 4. DOB VALIDATION
    // ============================================================

    const dobRegex = /^\d{4}-\d{2}-\d{2}$/;
    const dateOfBirth = String(dob).trim();

    if (!dobRegex.test(dateOfBirth)) {
      return res.status(400).json({
        success: false,
        message: "DOB must be in YYYY-MM-DD format",
      });
    }

    // ============================================================
    // 5. NAME
    // ============================================================

    const nameParts = String(fullName).trim().split(/\s+/);

    if (nameParts.length < 2) {
      return res.status(400).json({
        success: false,
        message: "Full name must contain first name and last name",
      });
    }

    const firstName = nameParts.shift();
    const lastName = nameParts.join(" ");

    // ============================================================
    // 6. CLEAN DATA
    // ============================================================

    const pan = String(panNumber).trim().toUpperCase();
    const mobile = String(mobileNumber).trim();
    const pin = String(pincode).trim();

    // ============================================================
    // 7. CONSENT TIMESTAMP
    // ============================================================

    const consentTimestamp = Math.floor(Date.now() / 1000);

    // ============================================================
    // 8. GRAPHQL QUERY
    // ============================================================

    const query = `
      mutation {
        verify(
          input: {
            documentType: "Experian Credit Bureau_S"
            mobile: "${mobile}"
            panNumber: "${pan}"
            firstName: "${firstName}"
            lastName: "${lastName}"
            dob: "${dateOfBirth}"
            pincode: "${pin}"
            consent: {
              consentFlag: true
              consentTimestamp: ${consentTimestamp}
              consentIpAddress: "127.0.0.1"
              consentMessageId: "CM_1"
            }
          }
        ) {
          status
          ok
          message

          result {
            __typename

            ... on ExperianCreditReportResult {

              Header {
                SystemCode
                MessageText
                ReportDate
                ReportTime
              }

              UserMessage {
                UserMessageText
              }

              CreditProfileHeader {
                ReportDate
                ReportTime
                Version
                ReportNumber
              }

              Match_result {
                Exact_match
              }

              TotalCAPS_Summary {
                TotalCAPSLast7Days
                TotalCAPSLast30Days
                TotalCAPSLast90Days
                TotalCAPSLast180Days
              }

              SCORE {
                FCIREXScore
                FCIREXScoreConfidLevel
              }

              CAIS_Account {
                CAIS_Summary
                CAIS_Account_DETAILS
              }

              CAPS {
                CAPS_Summary
                CAPS_Application_Details
              }

              NonCreditCAPS {
                NonCreditCAPS_Summary
                CAPS_Application_Details
              }

              Current_Application {
                Current_Application_Details
              }

              excelExperianReport
            }
          }

          error {
            decryptedError
          }
        }
      }
    `;

    // ============================================================
    // 9. PAYLOAD
    // ============================================================

    const payload = {
      query,
      variables: {},
    };

    // ============================================================
    // 10. ENV CONFIG
    // ============================================================

    const baseUrl = process.env.INDICONNECT_BASE_URL?.trim();
    const accessKey = process.env.INDICONNECT_ACCESS_KEY?.trim();
    const secretKey = process.env.INDICONNECT_SECRET_KEY?.trim();
    const serviceKey = process.env.INDICONNECT_SERVICE_KEY?.trim();

    const myAppId =
      process.env.INDICONNECT_EXPERIAN_MY_APP_ID?.trim() ||
      "verification_v5_1_app";

    const providerCode =
      process.env.INDICONNECT_EXPERIAN_PROVIDER_CODE?.trim() || "PGG3GFU7";

    const endpoint =
      process.env.INDICONNECT_EXPERIAN_ENDPOINT?.trim() ||
      "/idverifygr/verification";

    // ============================================================
    // 11. ENV VALIDATION
    // ============================================================

    if (!baseUrl || !accessKey || !secretKey || !serviceKey) {
      console.error("[EXPERIAN] Missing environment variables");

      return res.status(500).json({
        success: false,
        message: "Experian API configuration is missing",
      });
    }

    // ============================================================
    // 12. HEADERS
    // ============================================================

    const headers = {
      myAppId,
      "service-key": serviceKey,
      Authorization: `x-api-access ${secretKey}:${accessKey}`,
      providercode: providerCode,
      "Content-Type": "application/json",
    };

    // ============================================================
    // 13. API URL
    // ============================================================

    const apiUrl =
      `${baseUrl.replace(/\/$/, "")}/` + `${endpoint.replace(/^\//, "")}`;

    console.log("[EXPERIAN] API URL:", apiUrl);

    console.log("[EXPERIAN] ENV CHECK:", {
      myAppId,
      providerCode,
      baseUrl,
      endpoint,

      accessKeyPresent: !!accessKey,
      accessKeyLength: accessKey.length,

      secretKeyPresent: !!secretKey,
      secretKeyLength: secretKey.length,

      serviceKeyPresent: !!serviceKey,
      serviceKeyLength: serviceKey.length,
    });

    // ============================================================
    // 14. CREATE PENDING CREDIT REPORT
    // ============================================================

    creditReport = await CreditReport.create({
      userId,
      orderId: orderId ? String(orderId).trim() : null,

      name: String(fullName).trim(),
      mobile,
      pan,

      reportType: "EXPERIAN",
      consent: "Y",
      bureau: "EXPERIAN",

      status: "Pending",

      reportUrl: null,
      localPath: null,
      reportData: null,
      score: null,

      isPublic: false,
    });

    console.log("[EXPERIAN] Pending Credit Report Created:", creditReport._id);

    // ============================================================
    // 15. CALL INDICONNECT
    // ============================================================

    const response = await axios.post(apiUrl, payload, {
      headers,
      timeout: 60000,
    });

    const apiData = response.data;

    console.log("[EXPERIAN] RESPONSE:", JSON.stringify(apiData, null, 2));

    // ============================================================
    // 16. VERIFY RESPONSE
    // ============================================================

    const verify = apiData?.data?.verify;

    if (!verify) {
      creditReport.status = "Failed";
      creditReport.reportData = apiData;

      await creditReport.save();

      // Bureau gave no usable payload — flat ₹30 fail fee
      const expFailCharge = await debitFailedPull(
        creditReport,
        "experian",
        "EXPERIAN",
      );
      return res.status(502).json({
        success: false,
        message: "Invalid response from Experian API",

        creditReportId: creditReport._id,
        userId: creditReport.userId,
        status: creditReport.status,

        response: apiData,

        failureCharge: expFailCharge.ok ? expFailCharge.total : 0,
      });
    }

    // ============================================================
    // 17. API FAILED
    // ============================================================

    if (!verify.ok) {
      creditReport.status = "Failed";
      creditReport.reportData = apiData;

      await creditReport.save();

      // Bureau verification rejected — flat ₹30 fail fee
      const expVerifyCharge = await debitFailedPull(
        creditReport,
        "experian",
        "EXPERIAN",
      );
      return res.status(400).json({
        success: false,

        message: verify.message || "Experian verification failed",

        creditReportId: creditReport._id,
        userId: creditReport.userId,
        status: creditReport.status,

        error: verify.error || null,
        result: verify.result || null,

        failureCharge: expVerifyCharge.ok ? expVerifyCharge.total : 0,
      });
    }

    // ============================================================
    // 18. RESULT
    // ============================================================

    const result = verify.result;

    if (!result) {
      creditReport.status = "Failed";
      creditReport.reportData = apiData;

      await creditReport.save();

      return res.status(400).json({
        success: false,

        message: "Experian report result not received",

        creditReportId: creditReport._id,
        userId: creditReport.userId,
        status: creditReport.status,

        error: verify.error || null,
      });
    }

    // ============================================================
    // 19. SCORE
    // ============================================================

    let score = null;

    const rawScore = result?.SCORE?.FCIREXScore;

    if (rawScore !== undefined && rawScore !== null && rawScore !== "") {
      const parsedScore = Number(rawScore);

      if (!Number.isNaN(parsedScore)) {
        score = parsedScore;
      }
    }

    const scoreConfidence = result?.SCORE?.FCIREXScoreConfidLevel ?? null;

    // ============================================================
    // 20. MATCH
    // ============================================================

    const exactMatch = result?.Match_result?.Exact_match ?? null;

    // ============================================================
    // 21. REPORT DETAILS
    // ============================================================

    const creditProfile = result?.CreditProfileHeader || {};

    const reportNumber = creditProfile.ReportNumber ?? null;

    const reportDate = creditProfile.ReportDate ?? null;

    const reportTime = creditProfile.ReportTime ?? null;

    const version = creditProfile.Version ?? null;

    // ============================================================
    // 22. GENERATE PDF FROM EXPERIAN JSON
    // ============================================================

    let localPath = null;

    try {
      localPath = await generateExperianPdf(
        result,
        creditReport._id.toString(),
      );

      console.log("[EXPERIAN] PDF generated:", localPath);
    } catch (pdfError) {
      console.error("[EXPERIAN] PDF generation failed:", pdfError.message);
    }

    // ============================================================
    // 23. PDF URL
    // ============================================================

    const pdfUrl = localPath
      ? `/uploads/credit-reports/experian/experian-${creditReport._id}.pdf`
      : null;

    // ============================================================
    // 24. PDF GENERATION FAILED
    // ============================================================

    if (!localPath) {
      creditReport.status = "Failed";
      creditReport.reportData = apiData;

      await creditReport.save();

      // Data arrived from the bureau but our PDF step failed — flat ₹30 fail fee
      const expPdfCharge = await debitFailedPull(
        creditReport,
        "experian",
        "EXPERIAN",
      );
      return res.status(500).json({
        success: false,

        message: "Experian report generated but PDF creation failed",

        creditReportId: creditReport._id,
        userId: creditReport.userId,

        status: creditReport.status,

        failureCharge: expPdfCharge.ok ? expPdfCharge.total : 0,
      });
    }

    // ============================================================
    // 25. UPDATE CREDIT REPORT
    // ============================================================

    creditReport.score = score;

    // No external report URL
    creditReport.reportUrl = null;

    // Local PDF filesystem path
    creditReport.localPath = pdfUrl;

    // Complete Experian API response
    creditReport.reportData = apiData;

    creditReport.status = "Success";

    await creditReport.save();

    console.log(
      "[EXPERIAN] Credit Report Updated Successfully:",
      creditReport._id,
    );

    // Wallet debit (Experian = ₹50 + GST) — post-success only
    await debitReportPull(creditReport, "experian", "EXPERIAN");

    // ============================================================
    // 26. FINAL RESPONSE
    // ============================================================

    return res.status(200).json({
      success: true,

      status: "success",

      message: verify.message || "Experian report generated successfully",

      creditReportId: creditReport._id,
      userId: creditReport.userId,

      score: creditReport.score,
      scoreConfidence,
      exactMatch,

      reportNumber,
      reportDate,
      reportTime,
      version,

      // External URL not used
      reportUrl: null,

      // Actual server filesystem path
      localPath: creditReport.localPath,

      // Browser/frontend URL
      pdfUrl,

      data: {
        header: result?.Header || null,

        userMessage: result?.UserMessage || null,

        totalCAPS: result?.TotalCAPS_Summary || null,

        caisAccount: result?.CAIS_Account || null,

        caps: result?.CAPS || null,

        nonCreditCAPS: result?.NonCreditCAPS || null,

        currentApplication: result?.Current_Application || null,
      },

      creditReport,
    });
  } catch (error) {
    // ============================================================
    // ERROR
    // ============================================================

    console.error("[EXPERIAN] ERROR:", error.message);

    // ============================================================
    // UPDATE PENDING REPORT TO FAILED
    // ============================================================

    if (creditReport) {
      try {
        creditReport.status = "Failed";

        creditReport.reportData = {
          error: error.response?.data || error.message,
        };

        await creditReport.save();
      } catch (dbError) {
        console.error(
          "[EXPERIAN] Failed to update report status:",
          dbError.message,
        );
      }
    }

    // ============================================================
    // AXIOS ERROR
    // ============================================================

    if (error.response) {
      console.error("[EXPERIAN] STATUS:", error.response.status);

      console.error(
        "[EXPERIAN] DATA:",
        JSON.stringify(error.response.data, null, 2),
      );

      // Bureau answered with an error — flat ₹30 fail fee
      const expCatchCharge = await debitFailedPull(
        creditReport,
        "experian",
        "EXPERIAN",
      );
      return res.status(error.response.status || 500).json({
        success: false,

        status: "failed",

        message: "Service Unavailable",

        creditReportId: creditReport?._id || null,

        userId: creditReport?.userId || null,

        error: error.response.data,

        failureCharge: expCatchCharge.ok ? expCatchCharge.total : 0,
      });
    }

    // ============================================================
    // NO RESPONSE
    // ============================================================

    if (error.request) {
      return res.status(504).json({
        success: false,

        status: "failed",

        message: "Experian API did not respond",

        creditReportId: creditReport?._id || null,

        userId: creditReport?.userId || null,
      });
    }

    // ============================================================
    // INTERNAL ERROR
    // ============================================================

    return res.status(500).json({
      success: false,

      status: "failed",

      message: "Internal server error",

      creditReportId: creditReport?._id || null,

      userId: creditReport?.userId || null,

      error: error.message,
    });
  }
};

/**
 * ============================================================
 * BUILD SUREPASS API URL
 * ============================================================
 */
const buildSurepassUrl = () => {
  const baseUrl = String(process.env.SUREPASS_BASE_URL || "").trim();

  const configuredEndpoint = String(
    process.env.SUREPASS_EQUIFAX_ENDPOINT || "",
  ).trim();

  if (!configuredEndpoint) {
    throw new Error("SUREPASS_EQUIFAX_ENDPOINT is not configured");
  }

  // If endpoint is already a complete URL
  if (
    configuredEndpoint.startsWith("http://") ||
    configuredEndpoint.startsWith("https://")
  ) {
    return configuredEndpoint;
  }

  if (!baseUrl) {
    throw new Error("SUREPASS_BASE_URL is not configured");
  }

  return `${baseUrl.replace(/\/+$/, "")}/${configuredEndpoint.replace(/^\/+/, "")}`;
};

/**
 * ============================================================
 * CLEAN NAME
 * ============================================================
 */
const cleanNameValue = (value) => {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
};

/**
 * ============================================================
 * CLEAN PAN
 * ============================================================
 */
const cleanPanValue = (value) => {
  return String(value || "")
    .trim()
    .toUpperCase();
};

/**
 * ============================================================
 * CLEAN MOBILE
 * ============================================================
 */
const cleanMobileValue = (value) => {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "");
};

/**
 * ============================================================
 * CLEAN GENDER
 * ============================================================
 */
const cleanGenderValue = (value) => {
  return String(value || "")
    .trim()
    .toLowerCase();
};

/**
 * ============================================================
 * TOKEN LOGGING
 * ============================================================
 *
 * NEVER log complete API token.
 */
const logTokenInfo = (token) => {
  if (!token) {
    console.log("[EQUIFAX] Surepass Token: NOT FOUND");
    return;
  }

  console.log("[EQUIFAX] Surepass Token Loaded: true");
  console.log("[EQUIFAX] Surepass Token Length:", token.length);

  if (token.length >= 10) {
    console.log(
      "[EQUIFAX] Surepass Token Preview:",
      `${token.substring(0, 6)}******${token.slice(-4)}`,
    );
  }
};

/**
 * ============================================================
 * MAIN EQUIFAX CONTROLLER
 * ============================================================
 */
const EquifaxReport = async (req, res) => {
  let creditReport = null;

  try {
    // ========================================================
    // 1. AUTHENTICATED USER
    // ========================================================

    const userId = req.user?._id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User authentication required",
      });
    }

    console.log("[EQUIFAX] Authenticated User:", userId.toString());

    // ========================================================
    // 2. GET REQUEST DATA
    // ========================================================

    const { name, panNumber, mobile, gender, consent, orderId } = req.body;

    // ========================================================
    // 3. ENVIRONMENT VALIDATION
    // ========================================================

    if (
      !process.env.SUREPASS_BASE_URL &&
      !process.env.SUREPASS_EQUIFAX_ENDPOINT
    ) {
      console.error("[EQUIFAX] Surepass environment variables are missing");

      return res.status(500).json({
        success: false,
        message: "Surepass configuration is missing",
      });
    }

    if (!process.env.SUREPASS_EQUIFAX_ENDPOINT) {
      console.error("[EQUIFAX] SUREPASS_EQUIFAX_ENDPOINT is missing");

      return res.status(500).json({
        success: false,
        message: "Surepass Equifax endpoint is not configured",
      });
    }

    // ========================================================
    // 4. REQUIRED FIELD VALIDATION
    // ========================================================

    const requiredFields = {
      name,
      panNumber,
      mobile,
      gender,
      consent,
    };

    const missingFields = Object.entries(requiredFields)
      .filter(
        ([, value]) =>
          value === undefined || value === null || String(value).trim() === "",
      )
      .map(([key]) => key);

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Required Equifax fields are missing",
        missingFields,
      });
    }

    // ========================================================
    // 5. CONSENT VALIDATION
    // ========================================================

    const normalizedConsent = String(consent).trim().toUpperCase();

    if (normalizedConsent !== "Y") {
      return res.status(400).json({
        success: false,
        message: "Customer consent must be Y",
      });
    }

    // ========================================================
    // 6. CLEAN DATA
    // ========================================================

    const cleanName = cleanNameValue(name);

    const cleanPan = cleanPanValue(panNumber);

    const cleanMobile = cleanMobileValue(mobile);

    const cleanGender = cleanGenderValue(gender);

    // ========================================================
    // 7. PAN VALIDATION
    // ========================================================

    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

    if (!panRegex.test(cleanPan)) {
      return res.status(400).json({
        success: false,
        message: "Invalid PAN number",
      });
    }

    // ========================================================
    // 8. MOBILE VALIDATION
    // ========================================================

    const mobileRegex = /^[6-9][0-9]{9}$/;

    if (!mobileRegex.test(cleanMobile)) {
      return res.status(400).json({
        success: false,
        message: "Invalid mobile number",
      });
    }

    // ========================================================
    // 9. SUREPASS PAYLOAD
    // ========================================================
    //
    // IMPORTANT:
    //
    // This matches your OLD WORKING EQUIFAX implementation.
    //
    // Old payload:
    //
    // {
    //   name,
    //   id_number,
    //   id_type,
    //   mobile,
    //   consent
    // }
    //
    // Gender is intentionally NOT sent to Surepass.
    // ========================================================

    const requestData = {
      name: cleanName,
      id_number: cleanPan,
      id_type: "pan",
      mobile: cleanMobile,
      consent: "Y",
    };

    console.log("[EQUIFAX] Request Data:", {
      ...requestData,
      id_number: "********",
      gender: cleanGender,
    });

    // ========================================================
    // 10. CREATE PENDING CREDIT REPORT
    // ========================================================

    creditReport = await CreditReport.create({
      userId,

      orderId: orderId ? String(orderId).trim() : null,

      name: cleanName,

      mobile: cleanMobile,

      pan: cleanPan,

      reportType: "EQUIFAX",

      bureau: "EQUIFAX",

      consent: "Y",

      status: "Pending",

      reportUrl: null,

      localPath: null,

      reportData: null,

      score: null,

      isPublic: false,
    });

    console.log("[EQUIFAX] Pending Report Created:", creditReport._id);

    // ========================================================
    // 11. GET SUREPASS API KEY
    // ========================================================
    //
    // VERY IMPORTANT:
    //
    // DO NOT USE:
    //
    // process.env.SUREPASS_API_TOKEN
    //
    // Old working code uses:
    //
    // getSurepassApiKeyValue()
    //
    // which first checks DB.
    // ========================================================

    const surepassApiKey = await getSurepassApiKeyValue();

    if (!surepassApiKey) {
      console.error("[EQUIFAX] Surepass API key not configured");

      creditReport.status = "Failed";

      creditReport.reportData = {
        error: "Surepass API key not configured",
      };

      await creditReport.save();

      return res.status(500).json({
        success: false,
        status: "failed",
        message: "Surepass API key not configured",
        creditReportId: creditReport._id,
        userId: creditReport.userId,
      });
    }

    // Safe token logging
    logTokenInfo(surepassApiKey);

    // ========================================================
    // 12. BUILD API URL
    // ========================================================

    const apiUrl = buildSurepassUrl();

    console.log("[EQUIFAX] Surepass API URL:", apiUrl);

    // ========================================================
    // 13. CALL SUREPASS
    // ========================================================
    //
    // IMPORTANT:
    //
    // DO NOT use axios.post() here.
    //
    // We are using the SAME old working flow:
    //
    // getSurepassApiKeyValue()
    //       ↓
    // makeCreditCheckRequest()
    //       ↓
    // makeRequest()
    //       ↓
    // axios()
    // ========================================================

    console.log("[EQUIFAX] Sending request to Surepass...");

    const response = await surepassClient.makeCreditCheckRequest(
      surepassApiKey,
      apiUrl,
      requestData,
    );

    const apiData = response?.data;

    console.log(
      "[EQUIFAX] Surepass Response:",
      JSON.stringify(apiData, null, 2),
    );

    // ========================================================
    // 14. CHECK API FAILURE
    // ========================================================

    if (apiData?.success === false || apiData?.status === false) {
      creditReport.status = "Failed";

      creditReport.reportData = apiData;

      await creditReport.save();

      const eqFailCharge = await debitFailedPull(
        creditReport,
        "equifax",
        "EQUIFAX",
      );

      return res.status(400).json({
        success: false,

        status: "failed",

        message: apiData?.message || "Equifax credit report request failed",

        creditReportId: creditReport._id,

        userId: creditReport.userId,

        status: creditReport.status,

        data: apiData,

        failureCharge: eqFailCharge.ok ? eqFailCharge.total : 0,
      });
    }

    // ========================================================
    // 15. GET REPORT URL
    // ========================================================

    const reportUrl =
      apiData?.reportUrl ||
      apiData?.pdfUrl ||
      apiData?.data?.reportUrl ||
      apiData?.data?.pdfUrl ||
      apiData?.data?.result?.reportUrl ||
      apiData?.data?.result?.pdfUrl ||
      apiData?.data?.report_url ||
      apiData?.data?.pdf_url ||
      apiData?.data?.credit_report_link ||
      apiData?.data?.report_link ||
      null;

    console.log("[EQUIFAX] Report URL:", reportUrl);

    // ========================================================
    // 16. GET CREDIT SCORE
    // ========================================================

    let score = null;

    const possibleScore =
      apiData?.score ??
      apiData?.credit_score ??
      apiData?.data?.score ??
      apiData?.data?.credit_score ??
      apiData?.data?.result?.score ??
      apiData?.data?.result?.credit_score ??
      null;

    if (
      possibleScore !== null &&
      possibleScore !== undefined &&
      possibleScore !== ""
    ) {
      const parsedScore = Number(possibleScore);

      if (!Number.isNaN(parsedScore)) {
        score = parsedScore;
      }
    }

    console.log("[EQUIFAX] Score:", score);

    // ========================================================
    // 17. GET REPORT ID
    // ========================================================

    const reportId =
      apiData?.reportId ||
      apiData?.reportID ||
      apiData?.data?.reportId ||
      apiData?.data?.reportID ||
      apiData?.data?.result?.reportId ||
      apiData?.data?.result?.reportID ||
      null;

    console.log("[EQUIFAX] Report ID:", reportId);

    // ========================================================
    // 18. SAVE REPORT LOCALLY
    // ========================================================

    let localPath = null;

    if (reportUrl) {
      try {
        localPath = await saveCreditReportLocally(
          reportUrl,
          creditReport._id.toString(),
          "equifax",
          "pdf",
        );

        console.log("[EQUIFAX] Report saved locally:", localPath);
      } catch (fileError) {
        console.error("[EQUIFAX] Local report save failed:", fileError.message);

        // API succeeded.
        // File saving failure should not
        // make the entire report fail.
      }
    } else {
      console.log("[EQUIFAX] No report URL received from API");
    }

    // ========================================================
    // 19. UPDATE CREDIT REPORT
    // ========================================================

    creditReport.reportId = reportId;

    creditReport.score = score;

    creditReport.reportUrl = reportUrl;

    creditReport.localPath = localPath;

    creditReport.reportData = apiData;

    creditReport.status = "Success";

    await creditReport.save();

    console.log("[EQUIFAX] Credit Report Updated:", creditReport._id);

    // ========================================================
    // 20. WALLET DEBIT
    // ========================================================

    await debitReportPull(creditReport, "equifax", "EQUIFAX");

    // ========================================================
    // 21. FINAL RESPONSE
    // ========================================================

    return res.status(200).json({
      success: true,

      status: "success",

      message: "Equifax credit report fetched successfully",

      creditReportId: creditReport._id,

      userId: creditReport.userId,

      reportId: creditReport.reportId,

      orderId: creditReport.orderId,

      score: creditReport.score,

      reportUrl: creditReport.reportUrl,

      localPath: creditReport.localPath,

      data: creditReport,
    });
  } catch (error) {
    // ========================================================
    // 22. ERROR HANDLING
    // ========================================================

    console.error("[EQUIFAX] Error:", error.message);

    // ========================================================
    // UPDATE PENDING -> FAILED
    // ========================================================

    if (creditReport) {
      try {
        creditReport.status = "Failed";

        creditReport.reportData = {
          error: error.response?.data || error.message,
        };

        await creditReport.save();
      } catch (dbError) {
        console.error(
          "[EQUIFAX] Failed to update report status:",
          dbError.message,
        );
      }
    }

    // ========================================================
    // SUREPASS HTTP ERROR
    // ========================================================

    if (error.response) {
      console.error("[EQUIFAX] HTTP STATUS:", error.response.status);

      console.error(
        "[EQUIFAX] API ERROR:",
        JSON.stringify(error.response.data, null, 2),
      );

      // ======================================================
      // AUTHENTICATION ERROR
      // ======================================================

      if (error.response.status === 401 || error.response.status === 403) {
        return res.status(error.response.status).json({
          success: false,

          status: "failed",

          message:
            "Surepass authentication failed. Please verify the Surepass API key.",

          creditReportId: creditReport?._id || null,

          userId: creditReport?.userId || null,

          error: error.response.data,
        });
      }

      // ======================================================
      // OTHER BUREAU/API ERROR
      // ======================================================

      let eqCatchCharge = {
        ok: false,
        total: 0,
      };

      if (creditReport) {
        eqCatchCharge = await debitFailedPull(
          creditReport,
          "equifax",
          "EQUIFAX",
        );
      }

      return res.status(error.response.status || 500).json({
        success: false,

        status: "failed",

        message: "Equifax API request failed",

        creditReportId: creditReport?._id || null,

        userId: creditReport?.userId || null,

        error: error.response.data,

        failureCharge: eqCatchCharge.ok ? eqCatchCharge.total : 0,
      });
    }

    // ========================================================
    // NO RESPONSE FROM SUREPASS
    // ========================================================

    if (error.request) {
      let timeoutCharge = {
        ok: false,
        total: 0,
      };

      if (creditReport) {
        timeoutCharge = await debitFailedPull(
          creditReport,
          "equifax",
          "EQUIFAX",
        );
      }

      return res.status(504).json({
        success: false,

        status: "failed",

        message: "Equifax API did not respond",

        creditReportId: creditReport?._id || null,

        userId: creditReport?.userId || null,

        errorCode: error.code,

        errorMessage: error.message,

        failureCharge: timeoutCharge.ok ? timeoutCharge.total : 0,
      });
    }

    // ========================================================
    // INTERNAL ERROR
    // ========================================================

    return res.status(500).json({
      success: false,

      status: "failed",

      message: "Internal server error",

      creditReportId: creditReport?._id || null,

      userId: creditReport?.userId || null,

      error: error.message,
    });
  }
};

const handleCrifResponse = (res, apiData) => {
  console.log("[CRIF] API Response:", JSON.stringify(apiData, null, 2));

  // API ne error diya
  if (apiData?.status === "ERROR" || apiData?.code >= 400) {
    return res.status(apiData?.code || 400).json({
      success: false,
      message: apiData?.message || "CRIF verification failed",
      error: apiData,
    });
  }

  // Successful response
  return res.status(200).json({
    success: true,
    message: apiData?.message || "CRIF report generated successfully",
    data: apiData,
  });
};

const getAllCreditReports = async (req, res) => {
  try {
    const userId = req.user?._id;

    // Authentication check
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User authentication required",
      });
    }

    // Bureau query se lena
    // Example:
    // /credit-reports?bureau=Experian
    // /credit-reports?bureau=CIBIL
    const { bureau } = req.query;

    // Base filter
    const filter = {
      userId: userId,
    };

    // Agar bureau diya gaya hai tab sirf us bureau ke reports fetch karo
    if (bureau) {
      filter.bureau = bureau;
    }

    const reports = await CreditReport.find(filter).sort({
      createdAt: -1,
    });

    return res.status(200).json({
      success: true,
      count: reports.length,
      data: reports,
    });
  } catch (error) {
    console.error("[CREDIT REPORTS] Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch credit reports",
      error: error.message,
    });
  }
};

const getCreditBureauDetails = async (req, res) => {
  try {
    // ==========================================
    // 1. GET LOGGED-IN USER ID
    // ==========================================

    const userId = req.user?._id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User authentication required",
      });
    }

    // ==========================================
    // 2. GET USER DETAILS
    // ==========================================

    const user = await User.findById(userId)
      .select("_id name email phone partner_id state city pincode")
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User details not found",
      });
    }

    // ==========================================
    // 3. FINAL RESPONSE
    // ==========================================

    return res.status(200).json({
      success: true,
      message: "Credit bureau details fetched successfully",

      data: {
        userId: user._id,
        name: user.name || null,
        mobile: user.phone || null,
        email: user.email || null,
        partnerId: user.partner_id || null,
        state: user.state || null,
        city: user.city || null,
        pincode: user.pincode || null,
      },
    });
  } catch (error) {
    console.error("[CREDIT BUREAU DETAILS] Error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch credit bureau details",
      error: error.message,
    });
  }
};

module.exports = {
  CibilReportFromDigi,
  CrifReport,
  ExperianReport,
  EquifaxReport,
  getAllCreditReports,
  getCreditBureauDetails,
};
