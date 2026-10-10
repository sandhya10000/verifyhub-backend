const axios = require("axios");
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
  console.log(cibilData, "CIBIL");
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
    if (raw === null || raw === undefined || raw === "" || raw === "-")
      continue;
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

// Post-failure debit — same guards as success. Single-plan launch: failed
// bureau pulls (including CIBIL) bill the SAME as success (see models/Pricing.js).
// TODO(multi-plan-restore): restore mismatch-gated CIBIL + flat fallback.
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

// CIBIL failure billing classifier — single source of truth for both the
// empty-data branch and the catch branch.
// Policy: deduct the fail fee ONLY on provider status 400 (bad request —
// partner-side input fault). Never deduct on 502/503/504 (service API
// down), on transport failures with no provider response, or when
// IndiConnect reports our own balance is exhausted (owner must recharge).
// Bureau-side "source/bureau down" IS billed (IndiConnect attempted the
// pull and bills us) unless the status itself is 502/503/504.
// Returns { bill: boolean, reason: string } — reason is for server logs.
// `status`: Number(provider status) or NaN when unknown.
// `texts`: array of message strings from every provider field available.
const classifyCibilFailure = (status, texts) => {
  const joined = (texts || [])
    .filter((t) => t !== null && t !== undefined)
    .map((t) => String(t))
    .join(" | ");

  // 1. Our IndiConnect balance exhausted — always free, needs owner action.
  // Shapes seen: decryptedError INSUFFICIENT_PROVIDER_BALANCE,
  // "Provider balance is low or zero", "Insufficient Wallet Balance",
  // "Insufficient balance to process this transaction".
  if (
    /INSUFFICIENT_PROVIDER_BALANCE|insufficient[^|]{0,40}balance|balance[^|]{0,40}(low|zero|exhausted|depleted|insufficient)|balance_exhausted/i.test(
      joined,
    )
  ) {
    return { bill: false, reason: "indiconnect-balance-exhausted" };
  }

  // 2. Service API itself down — always free.
  const code = Number(status);
  if (code === 502 || code === 503 || code === 504) {
    return { bill: false, reason: "service-down-status" };
  }
  if (
    /service[^|]{0,20}(down|unavailable)|temporarily unavailable|try again later|under maintenance|maintenance|gateway (timeout|error)|bad gateway|upstream|provider[^|]{0,20}(down|unavailable|timeout|error)|connection (refused|timed? ?out)|timed? ?out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(
      joined,
    )
  ) {
    return { bill: false, reason: "service-down-message" };
  }

  // 3. Bureau source attempted but failed (billed to us) — bill it.
  if (/source[^|]{0,20}down|bureau[^|]{0,20}(down|unavailable)/i.test(joined)) {
    return { bill: true, reason: "bureau-source-down" };
  }

  // 4. Only status 400 bills. Anything else (no-record status 2,
  // unknown codes, transport errors with no provider response) is free.
  if (code === 400) {
    return { bill: true, reason: "bad-request" };
  }
  return { bill: false, reason: "non-billable-status" };
};
//logic for cibil report from indiconnect
const CibilReportFromDigi = async (req, res) => {
  let creditReport = null;

  try {
    console.log("[CIBIL] Starting CIBIL IndiConnect report generation...");

    // ============================================================
    // 1. INDICONNECT CONFIG (mirrors ExperianReport pattern)
    // ============================================================

    const baseUrl = process.env.INDICONNECT_BASE_URL?.trim();
    const accessKey = process.env.INDICONNECT_ACCESS_KEY?.trim();
    const secretKey = process.env.INDICONNECT_SECRET_KEY?.trim();
    const serviceKey = process.env.INDICONNECT_SERVICE_KEY?.trim();

    // NOTE: the CIBIL provider code must be the CIBIL-specific code from
    // the IndiConnect dashboard (one that has bureau-verification-cibil
    // enabled). It is intentionally NOT defaulted to the Experian/CRIF
    // codes — sending another product's providercode yields
    // "Unsupported document type: bureau-verification-cibil".
    const providerCode =
      process.env.INDICONNECT_CIBIL_PROVIDER_CODE?.trim() || "";

    const endpoint =
      process.env.INDICONNECT_CIBIL_ENDPOINT?.trim() ||
      "/idverifygr/verification";

    const documentType =
      process.env.INDICONNECT_CIBIL_DOCUMENT_TYPE?.trim() ||
      "bureau-verification-cibil";

    if (!baseUrl || !accessKey || !secretKey || !serviceKey) {
      console.error("[CIBIL] Missing IndiConnect environment variables");

      return res.status(500).json({
        success: false,
        message: "CIBIL API configuration is missing",
      });
    }

    if (!providerCode) {
      console.error(
        "[CIBIL] INDICONNECT_CIBIL_PROVIDER_CODE is not configured",
      );

      return res.status(500).json({
        success: false,
        message:
          "CIBIL provider code is not configured. Set INDICONNECT_CIBIL_PROVIDER_CODE to the CIBIL-enabled code from the IndiConnect dashboard.",
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
      email,
      pan,
      gender,
      dob,
      address,
      state,
      city,
      pincode,
      reportType,
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
    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    if (!gender) {
      return res.status(400).json({
        success: false,
        message: "Gender is required",
      });
    }

    if (!dob) {
      return res.status(400).json({
        success: false,
        message: "Date of birth is required",
      });
    }

    if (!state) {
      return res.status(400).json({
        success: false,
        message: "State is required",
      });
    }

    if (!city) {
      return res.status(400).json({
        success: false,
        message: "City is required",
      });
    }

    if (!pincode) {
      return res.status(400).json({
        success: false,
        message: "Pincode is required",
      });
    }

    if (consent !== "Y") {
      return res.status(400).json({
        success: false,
        message: "Customer consent is required",
      });
    }

    // Wallet gate: 0/insufficient balance par IndiConnect API hit hi nahi hogi —
    // na Pending doc banega, na provider cost lagegi.
    if (!(await affordOr402(req, res, "cibil"))) return;

    // ============================================================
    // 3. INDICONNECT GRAPHQL QUERY + PAYLOAD
    // Contract (per IndiConnect "Bureau Verification B (CIBIL)" docs):
    // POST {baseUrl}{endpoint} with headers
    // { service-key, Authorization: x-api-access secret:access,
    //   providercode (CIBIL-enabled code), Content-Type: application/json }.
    // NOTE: no myAppId header — that is Experian-only.
    // ============================================================

    const CIBIL_QUERY = `
      mutation VerifyBureauB($input: VerifyInput!) {
        verify(input: $input) {
          ok
          message
          status
          result {
            ... on BTBureauBResult {
              txn_id
              api_category
              api_name
              billable
              message
              status
              datetime
              client_id
              htmlUrl
              cibilData
            }
          }
          error {
            status
            message
            decryptedError
            raw
          }
        }
      }
    `;

    const indiPayload = {
      query: CIBIL_QUERY,
      variables: {
        input: {
          documentType,
          pan: pan.toString().trim().toUpperCase(),
          name: customerName,
          mobile: mobile.toString().trim(),
        },
      },
    };

    console.log("[CIBIL] IndiConnect Payload:", {
      documentType,
      name: customerName,
      mobile: "********",
      pan: "********",
    });

    // ============================================================
    // 4. CALL INDICONNECT API
    // ============================================================

    const apiUrl =
      `${baseUrl.replace(/\/$/, "")}/` + `${endpoint.replace(/^\//, "")}`;

    console.log("[CIBIL] Calling:", apiUrl);
    console.log("[CIBIL] Provider Code:", providerCode);

    const headers = {
      "service-key": serviceKey,
      Authorization: `x-api-access ${secretKey}:${accessKey}`,
      providercode: providerCode,
      "Content-Type": "application/json",
    };

    const response = await axios.post(apiUrl, indiPayload, {
      headers,
      timeout: 60000,
    });

    let apiData = response.data;

    console.log("[CIBIL] IndiConnect verify ok:", apiData?.data?.verify?.ok);

    // ============================================================
    // 5. PARSE INDICONNECT RESPONSE + ADAPT TO LEGACY SHAPE
    // Downstream (extractCibilScore, generateCibilPdf) expects
    // apiData.data.cibilData (Digi shape). IndiConnect nests it at
    // data.verify.result.cibilData, so expose it at data.cibilData
    // while keeping the raw GraphQL response for audit.
    // ============================================================

    const verify = apiData?.data?.verify || null;
    const indiResult = verify?.result || null;
    const rawCibilData = indiResult?.cibilData || null;
    const cibilData =
      rawCibilData && typeof rawCibilData === "string"
        ? (() => {
            try {
              return JSON.parse(rawCibilData);
            } catch {
              return rawCibilData;
            }
          })()
        : rawCibilData;
    const indiTxnId = indiResult?.txn_id || null;
    const indiBillable = indiResult?.billable;
    const indiBureauStatus = indiResult?.status;
    const indiBureauMessage = String(
      indiResult?.message || verify?.message || "",
    );
    const isNoRecord =
      Number(indiBureauStatus) === 2 || /no record found/i.test(indiBureauMessage);
    // Failure billing inputs for classifyCibilFailure (see helper above):
    // provider status (verify.status, else result.status) + every message
    // field IndiConnect may use, including verify.error (balance-exhausted
    // arrives as error.decryptedError INSUFFICIENT_PROVIDER_BALANCE).
    const indiVerifyError = verify?.error || null;
    const cibilFailureTexts = [
      indiBureauMessage,
      indiVerifyError?.message,
      indiVerifyError?.decryptedError,
      indiVerifyError?.raw,
      ...(apiData?.errors || []).map((e) => e?.message || e),
    ];
    const cibilFailureStatus = Number(
      verify?.status ?? indiResult?.status ?? NaN,
    );

    if (apiData?.errors?.length) {
      console.error(
        "[CIBIL] IndiConnect GraphQL Errors:",
        JSON.stringify(apiData.errors, null, 2),
      );
    }

    console.log("[CIBIL] Txn:", indiTxnId, "billable:", indiBillable);

    // Adapted shape for legacy downstream (score extractor + PDF service).
    if (cibilData) {
      apiData = {
        ...apiData,
        data: {
          ...(apiData?.data || {}),
          cibilData,
        },
      };
    }

    // ============================================================
    // 6. CHECK CIBIL DATA
    // ============================================================

    if (!cibilData || isNoRecord) {
      // Provider answered but returned no usable CIBIL data — record as
      // Failed. Fail fee applies ONLY per classifyCibilFailure: status 400
      // (or bureau source-down) bills; 502/503/504, service-down messages
      // and our own IndiConnect balance exhaustion stay free.
      creditReport = await CreditReport.create({
        userId: req.user?._id,
        orderId: orderId || null,
        name: customerName,
        firstName: firstName || null,
        lastName: lastName || null,
        mobile: mobile?.toString().trim() || null,
        email: email?.toString().trim().toLowerCase() || null,
        pan: pan?.toString().trim().toUpperCase() || null,
        gender: gender || null,
        dob: dob || null,
        address: address || null,
        state: state || null,
        city: city || null,
        pincode: pincode?.toString().trim() || null,
        reportType: reportType || "CIBIL",
        consent: "Y",
        bureau: "CIBIL",
        status: "Failed",
        reportUrl: null,
        localPath: null,
        reportData: apiData,
        score: null,
        isPublic: false,
      });

      console.log(
        "[CIBIL] Empty-data CreditReport marked as Failed:",
        creditReport._id,
        "txn:",
        indiTxnId,
        "bureauStatus:",
        indiBureauStatus,
      );

      // Fail fee ONLY on status 400 / bureau source-down (billable to us).
      // Service-down, 502/503/504 and our IndiConnect balance exhaustion
      // stay free — same policy as provider auth failures.
      const emptyVerdict = classifyCibilFailure(
        cibilFailureStatus,
        cibilFailureTexts,
      );
      let cibilEmptyCharge = { ok: false, total: 0 };
      if (emptyVerdict.bill) {
        cibilEmptyCharge = await debitFailedPull(
          creditReport,
          "cibil",
          "CIBIL",
        );
      } else {
        console.log(
          `[wallet] CIBIL fail free (${emptyVerdict.reason}) for report ${creditReport._id}`,
        );
      }
      if (emptyVerdict.reason === "indiconnect-balance-exhausted") {
        console.error(
          "[CIBIL] IndiConnect provider balance exhausted — owner recharge needed.",
        );
      }

      return res.status(
        emptyVerdict.reason === "indiconnect-balance-exhausted" ||
          emptyVerdict.reason.startsWith("service-down")
          ? 503
          : 400,
      ).json({
        success: false,
        message:
          emptyVerdict.reason === "indiconnect-balance-exhausted"
            ? "Verification service temporarily unavailable. Please try again later."
            : indiBureauMessage || "CIBIL data not found in Bureau",
        creditReportId: creditReport._id,
        status: creditReport.status,
        data: apiData,
        failureCharge: cibilEmptyCharge.ok ? cibilEmptyCharge.total : 0,
      });
    }

    // ============================================================
    // 7. CREATE CREDIT REPORT IN DATABASE
    // ============================================================

    creditReport = await CreditReport.create({
      userId: req.user?._id,

      orderId: orderId || null,

      // ============================================================
      // CUSTOMER DETAILS
      // ============================================================

      name: customerName,

      firstName: firstName || null,

      lastName: lastName || null,

      mobile: mobile?.toString().trim() || null,

      email: email?.toString().trim().toLowerCase() || null,

      pan: pan?.toString().trim().toUpperCase() || null,

      gender: gender || null,

      dob: dob || null,

      address: address || null,

      state: state || null,

      city: city || null,

      pincode: pincode?.toString().trim() || null,

      // ============================================================
      // REPORT DETAILS
      // ============================================================

      reportType: reportType || "CIBIL",

      consent: "Y",

      bureau: "CIBIL",

      status: "Pending",

      // No link until our PDF exists — the provider htmlUrl is token-gated
      // and must never surface as the report link (kept in reportData).
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
      "txn:",
      indiTxnId,
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
    // Persist the uploads-folder relative path in BOTH fields (same as
    // CRIF/Experian/Equifax) so history buttons open our created PDF.
    // The absolute disk path (pdf.filePath) is server-only. The provider
    // htmlUrl stays inside raw reportData for audit — never as the link,
    // since it is token-gated to IndiConnect's session.
    // ============================================================

    creditReport.localPath = pdf.relativePath;

    creditReport.reportUrl = pdf.relativePath;

    // Re-derive score at completion (same extractor as creation) so the
    // final Success row can never carry a stale null.
    const finalScore = extractCibilScore(apiData);
    if (finalScore !== null) creditReport.score = finalScore;

    creditReport.status = "Success";

    await creditReport.save();

    console.log("[CIBIL] CreditReport updated with PDF");

    // Wallet debit (tiered per-report price) — post-success only, mirroring
    // Experian/CRIF/Equifax. Without this CIBIL pulls were free AND the
    // header balance never moved.
    await debitReportPull(creditReport, "cibil", "CIBIL");

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
    // INDICONNECT ERROR
    // ============================================================

    if (error.response) {
      console.error("[CIBIL] IndiConnect API status:", error.response.status);

      console.error("[CIBIL] IndiConnect API response:", error.response.data);
    }

    // Provider auth failures (bad/rotated keys, inactive product) surface
    // as 401/403s. Don't leak raw provider strings to the UI — full body
    // stays server-side above.
    const indiStatus = error.response?.status;
    const isIndiAuthFailure =
      indiStatus === 401 ||
      indiStatus === 403 ||
      /authentication failed/i.test(
        String(error.response?.data?.message || ""),
      );

    // Failure billing per classifyCibilFailure: ONLY status 400 (or
    // bureau source-down) bills. 502/503/504, transport failures with no
    // provider response, service-down wording and our own IndiConnect
    // balance exhaustion stay free. Auth failures stay free as before.
    // The HTTP shape { status: "ERROR", code: 400, message:
    // "Insufficient Wallet Balance" } lands here via error.response.data.
    const catchBody = error.response?.data || null;
    const catchTexts = [
      catchBody?.message,
      catchBody?.error?.message,
      catchBody?.decryptedError,
      error.message,
    ];
    const catchNoResponse = !error.response && !!error.request;
    const catchVerdict = classifyCibilFailure(
      catchNoResponse ? NaN : indiStatus,
      catchTexts,
    );

    // Failed CIBIL pulls bill per pricing config (₹60 fail fee in
    // single-plan mode) — same as CRIF/Experian/Equifax. Never throws.
    let cibilFailCharge = { ok: false, total: 0 };
    if (!isIndiAuthFailure && catchVerdict.bill) {
      cibilFailCharge = await debitFailedPull(
        creditReport,
        "cibil",
        "CIBIL",
      );
    } else {
      console.log(
        `[wallet] CIBIL fail free (${
          isIndiAuthFailure ? "provider auth failure" : catchVerdict.reason
        })`,
      );
    }
    if (catchVerdict.reason === "indiconnect-balance-exhausted") {
      console.error(
        "[CIBIL] IndiConnect provider balance exhausted — owner recharge needed.",
      );
    }

    return res.status(indiStatus || 500).json({
      success: false,

      message: isIndiAuthFailure
        ? "Bureau authentication failed. Please contact support."
        : catchVerdict.reason === "indiconnect-balance-exhausted"
          ? "Verification service temporarily unavailable. Please try again later."
          : error.response?.data?.message || "Failed to generate CIBIL report",

      error: error.response?.data || error.message,

      creditReportId: creditReport?._id || null,

      failureCharge: cibilFailCharge.ok ? cibilFailCharge.total : 0,
    });
  }
};
//Without OTP
const CrifReport = async (req, res) => {
  let creditReport = null;

  try {
    const {
      fullName,
      mobileNumber,
      panNumber,
      email,
      dob,
      gender,
      pincode,
      stateName,
      cityName,
      customerConsent,
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
      process.env.INDICONNECT_CRIF_ENDPOINT || "/idverifygr/verification";

    const providerCode =
      process.env.INDICONNECT_CRIF_PROVIDER_CODE || "O6EHSHOS";

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
    // STEP 4: INPUT VALIDATION
    // ============================================================

    if (
      !fullName ||
      String(fullName).trim() === "" ||
      !mobileNumber ||
      String(mobileNumber).trim() === ""
    ) {
      return res.status(400).json({
        success: false,
        message: "Full name and mobile number are required",
      });
    }

    const name = String(fullName).trim();
    const mobile = String(mobileNumber).trim();

    // ============================================================
    // STEP 5: MOBILE VALIDATION
    // ============================================================

    if (!/^[6-9]\d{9}$/.test(mobile)) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid 10 digit mobile number",
      });
    }

    // ============================================================
    // STEP 6: API URL
    // ============================================================

    const apiUrl =
      `${baseUrl.replace(/\/$/, "")}/` + `${crifEndpoint.replace(/^\/+/, "")}`;

    console.log("[CRIF] API URL:", apiUrl);
    console.log("[CRIF] Provider Code:", providerCode);

    // ============================================================
    // STEP 7: HEADERS
    // ============================================================

    const headers = {
      "service-key": serviceKey,
      Authorization: `x-api-access ${secretKey}:${accessKey}`,
      providercode: providerCode,
      "Content-Type": "application/json",
    };

    // ============================================================
    // STEP 8: GRAPHQL QUERY
    // ============================================================

    const query = `
      mutation VerifyBureauC($input: VerifyInput!) {
        verify(input: $input) {
          ok
          message
          status
          result {
            ... on BTBureauCResult {
              txn_id
              api_category
              api_name
              billable
              message
              status
              datetime
              bureauData
            }
          }
          error {
            status
            message
          }
        }
      }
    `;

    // ============================================================
    // STEP 9: GRAPHQL PAYLOAD
    // ============================================================

    const payload = {
      query,
      variables: {
        input: {
          documentType: "bureau-verification-crif",
          name,
          mobile,
        },
      },
    };

    console.log("[CRIF] Request Payload:", JSON.stringify(payload, null, 2));

    // ============================================================
    // STEP 10: WALLET GATE
    // ============================================================

    // Wallet gate (CRIF = ₹50 + GST) — after validation, before the Pending
    // doc and provider call, mirroring CIBIL/Experian/Equifax. Every submit
    // pulls fresh — repeat PANs are billed as new pulls, never blocked.
    if (!(await affordOr402(req, res, "crif"))) return;

    // ============================================================
    // STEP 11: CREATE PENDING REPORT
    // ============================================================

    creditReport = await CreditReport.create({
      userId,
      orderId: orderId ? String(orderId).trim() : null,

      name,
      mobile,

      pan: panNumber ? String(panNumber).trim().toUpperCase() : null,

      email: email ? String(email).trim().toLowerCase() : null,

      dob: dob || null,

      gender: gender ? String(gender).trim() : "",

      address: "",

      state: stateName ? String(stateName).trim() : "",

      city: cityName ? String(cityName).trim() : "",

      pincode: pincode ? String(pincode).trim() : "",

      reportType: "CRIF",
      consent: customerConsent || "Y",
      bureau: "CRIF",

      status: "Pending",

      reportUrl: null,
      localPath: null,
      reportData: null,

      isPublic: false,
    });

    console.log("[CRIF] Pending Report Created:", creditReport._id);

    // ============================================================
    // STEP 12: CALL INDICONNECT CRIF API
    // ============================================================

    const response = await axios.post(apiUrl, payload, {
      headers,
      timeout,
    });

    const apiData = response.data;

    console.log("[CRIF] API Response:", JSON.stringify(apiData, null, 2));

    // ============================================================
    // STEP 13: GRAPHQL RESPONSE
    // ============================================================

    const verifyData = apiData?.data?.verify;

    // ============================================================
    // GRAPHQL LEVEL ERROR
    // ============================================================

    if (apiData?.errors?.length) {
      console.error(
        "[CRIF] GraphQL Errors:",
        JSON.stringify(apiData.errors, null, 2),
      );

      creditReport.status = "Failed";
      creditReport.reportData = apiData;

      await creditReport.save();

      const crifFailCharge = await debitFailedPull(
        creditReport,
        "crif",
        "CRIF",
      );

      return res.status(400).json({
        success: false,
        status: "failed",

        message: apiData.errors?.[0]?.message || "CRIF GraphQL request failed",

        creditReportId: creditReport._id,

        data: apiData,

        failureCharge: crifFailCharge.ok ? crifFailCharge.total : 0,
      });
    }

    // ============================================================
    // STEP 14: VERIFY RESPONSE VALIDATION
    // ============================================================

    if (!verifyData) {
      creditReport.status = "Failed";
      creditReport.reportData = apiData;

      await creditReport.save();

      const crifFailCharge = await debitFailedPull(
        creditReport,
        "crif",
        "CRIF",
      );

      return res.status(400).json({
        success: false,
        status: "failed",

        message: "Invalid response received from CRIF API",

        creditReportId: creditReport._id,

        data: apiData,

        failureCharge: crifFailCharge.ok ? crifFailCharge.total : 0,
      });
    }

    // ============================================================
    // STEP 15: CHECK CRIF STATUS
    // ============================================================

    /*
      Actual CRIF response:

      verify.ok = true
      verify.status = 200
      verify.result.status = 1

      So we must support:
      - true
      - "true"
      - 1
      - 200
      - "success"
    */

    const verifyOk =
      verifyData?.ok === true ||
      verifyData?.ok === "true" ||
      verifyData?.ok === 1;

    const verifyStatus = Number(verifyData?.status);

    const resultStatus = Number(verifyData?.result?.status);

    const verifyStatusText = String(verifyData?.status || "").toLowerCase();

    const resultStatusText = String(
      verifyData?.result?.status || "",
    ).toLowerCase();

    const isSuccess =
      verifyOk &&
      (verifyStatus === 200 ||
        verifyStatus === 1 ||
        resultStatus === 1 ||
        resultStatus === 200 ||
        verifyStatusText === "success" ||
        resultStatusText === "success");

    console.log("[CRIF] Verify OK:", verifyData?.ok);

    console.log("[CRIF] Verify Status:", verifyData?.status);

    console.log("[CRIF] Result Status:", verifyData?.result?.status);

    console.log("[CRIF] Is Success:", isSuccess);

    // ============================================================
    // STEP 16: RESULT
    // ============================================================

    const result = verifyData?.result || null;

    // ============================================================
    // STEP 17: BUREAU DATA
    // ============================================================

    let bureauData = result?.bureauData || null;

    /*
      Sometimes GraphQL JSON scalar may come as string.
      Convert it into object if required.
    */

    if (typeof bureauData === "string") {
      try {
        bureauData = JSON.parse(bureauData);

        console.log("[CRIF] bureauData string parsed successfully");
      } catch (parseError) {
        console.error(
          "[CRIF] bureauData JSON parse failed:",
          parseError.message,
        );
      }
    }

    // ============================================================
    // STEP 18: FAILED RESPONSE
    // ============================================================

    if (!isSuccess) {
      creditReport.status = "Failed";
      creditReport.reportData = apiData;

      await creditReport.save();

      const crifFailCharge = await debitFailedPull(
        creditReport,
        "crif",
        "CRIF",
      );

      return res.status(400).json({
        success: false,
        status: "failed",

        message:
          verifyData?.message ||
          result?.message ||
          verifyData?.error?.message ||
          "CRIF report request failed",

        creditReportId: creditReport._id,

        transactionId: result?.txn_id || null,

        data: apiData,

        failureCharge: crifFailCharge.ok ? crifFailCharge.total : 0,
      });
    }

    // ============================================================
    // STEP 19: EXTRACT TRANSACTION ID
    // ============================================================

    const transactionId = result?.txn_id || null;

    console.log("[CRIF] Transaction ID:", transactionId);

    // ============================================================
    // STEP 20: EXTRACT SCORE
    // ============================================================

    let score = null;

    const possibleScores = [
      bureauData?.score,
      bureauData?.Score,
      bureauData?.creditScore,
      bureauData?.credit_score,

      // Actual CRIF structure
      bureauData?.credit_report?.SCORES?.SCORE?.["SCORE-VALUE"],
      bureauData?.credit_report?.SCORES?.SCORE?.score,

      bureauData?.SCORES?.SCORE?.["SCORE-VALUE"],
      bureauData?.SCORES?.SCORE?.score,

      bureauData?.B2C?.score,
      bureauData?.["B2C-SCORE"],
      result?.score,
    ];

    for (const value of possibleScores) {
      if (value !== undefined && value !== null && value !== "") {
        const parsedScore = Number(String(value).replace(/,/g, "").trim());

        if (!Number.isNaN(parsedScore)) {
          score = parsedScore;
          break;
        }
      }
    }

    console.log("[CRIF] Extracted Score:", score);

    // ============================================================
    // STEP 21: EXTRACT REPORT ID
    // ============================================================

    const crifReportId =
      bureauData?.reportId ||
      bureauData?.reportID ||
      bureauData?.report_id ||
      result?.reportId ||
      result?.reportID ||
      result?.report_id ||
      transactionId ||
      null;

    console.log("[CRIF] Report ID:", crifReportId);

    // ============================================================
    // STEP 22: EXTRACT REPORT URL
    // ============================================================

    const reportUrl =
      bureauData?.reportUrl ||
      bureauData?.reportURL ||
      bureauData?.pdfUrl ||
      bureauData?.pdfURL ||
      bureauData?.["credit_report_link"] ||
      result?.reportUrl ||
      result?.reportURL ||
      result?.pdfUrl ||
      result?.pdfURL ||
      result?.credit_report_link ||
      null;

    console.log("[CRIF] Report URL:", reportUrl);

    // ============================================================
    // STEP 23: GENERATE LOCAL PDF
    // ============================================================

    // ============================================================
    // STEP 23: DOWNLOAD PROVIDER PDF TO LOCAL STORAGE
    // ============================================================

    let localPath = null;

    try {
      if (!reportUrl) {
        throw new Error("CRIF provider PDF URL not found");
      }

      // Physical folder:
      // backend/uploads/credit-reports/crif
      const crifUploadDir = path.join(
        __dirname,
        "../uploads/credit-reports/crif",
      );

      // Create folder if it does not exist
      if (!fs.existsSync(crifUploadDir)) {
        fs.mkdirSync(crifUploadDir, {
          recursive: true,
        });
      }

      // Use transaction ID for unique filename
      const fileName = `crif-${transactionId || creditReport._id}.pdf`;

      // Physical file path
      const physicalFilePath = path.join(crifUploadDir, fileName);

      console.log("[CRIF] Downloading provider PDF...");
      console.log("[CRIF] Provider PDF URL:", reportUrl);
      console.log("[CRIF] Local file path:", physicalFilePath);

      const pdfResponse = await axios.get(reportUrl, {
        responseType: "arraybuffer",
        timeout: 60000,
      });

      fs.writeFileSync(physicalFilePath, pdfResponse.data);

      // Path to store in MongoDB
      localPath = `/uploads/credit-reports/crif/${fileName}`;

      console.log("[CRIF] Provider PDF saved successfully:", physicalFilePath);

      console.log("[CRIF] DB localPath:", localPath);
    } catch (pdfError) {
      console.error("[CRIF] Provider PDF download failed:", pdfError.message);

      localPath = null;
    }

    // ============================================================
    // STEP 24: UPDATE DATABASE
    // ============================================================

    creditReport.reportId = crifReportId;
    creditReport.score = score;
    creditReport.reportUrl = reportUrl;

    // Provider PDF ka local path
    creditReport.localPath = localPath;

    // Save complete Indiconnect response
    creditReport.reportData = apiData;

    creditReport.status = "Success";

    await creditReport.save();

    console.log("[CRIF] Report saved successfully:", creditReport._id);

    console.log("[CRIF] Local PDF path:", creditReport.localPath);

    // ============================================================
    // STEP 25: WALLET DEBIT
    // ============================================================

    // Uncomment when you want to debit successful CRIF pull

    await debitReportPull(creditReport, "crif", "CRIF");

    // ============================================================
    // STEP 26: SUCCESS RESPONSE
    // ============================================================

    return res.status(200).json({
      success: true,
      status: "success",

      message:
        verifyData?.message ||
        result?.message ||
        "CRIF report fetched successfully",

      creditReportId: creditReport._id,

      userId: creditReport.userId,

      reportId: creditReport.reportId,

      orderId: creditReport.orderId,

      transactionId,

      score: creditReport.score,

      reportUrl: creditReport.reportUrl,

      localPath: creditReport.localPath,

      bureauData,

      data: creditReport,
    });
  } catch (error) {
    // ============================================================
    // ERROR HANDLING
    // ============================================================

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

      const crifErrCharge = creditReport
        ? await debitFailedPull(creditReport, "crif", "CRIF")
        : {
            ok: false,
            total: 0,
          };

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
    // 3A. WALLET GATE
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

      email: email?.toString().trim().toLowerCase() || null,

      dob: dob || null,

      address: "",

      state: stateName?.toString().trim() || "",

      city: cityName?.toString().trim() || "",

      pincode: pincode?.toString().trim() || "",

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

      // Bureau gave no usable payload — Experian fail fee (₹40 single-plan)
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

      // Bureau verification rejected — Experian fail fee (₹40 single-plan)
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

      // Bureau 400-class reject with no usable result — bill the fail fee
      // like every other Experian rejection.
      const expNoResultCharge = await debitFailedPull(
        creditReport,
        "experian",
        "EXPERIAN",
      );
      return res.status(400).json({
        success: false,

        message: "Experian report result not received",

        creditReportId: creditReport._id,
        userId: creditReport.userId,
        status: creditReport.status,

        error: verify.error || null,

        failureCharge: expNoResultCharge.ok ? expNoResultCharge.total : 0,
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

      // Data arrived from the bureau but our PDF step failed — Experian fail fee (₹40 single-plan)
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

      // Bureau answered with an error — Experian fail fee (₹40 single-plan)
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

    const {
      name,
      panNumber,
      mobile,
      gender,
      dob,
      email,
      address,
      state,
      city,
      pincode,
      consent,
      orderId,
    } = req.body;

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
      dob,
      email,
      state,
      city,
      pincode,
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

    // Wallet gate: 0/insufficient balance par Surepass API hit hi nahi hogi —
    // na Pending doc banega, na provider cost lagegi.
    if (!(await affordOr402(req, res, "equifax"))) return;

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
      dob: dob || null,
      email: email?.trim() || null,
      address: address?.trim() || "",
      state: state?.trim() || "",
      city: city?.trim() || "",
      pincode: pincode?.trim() || "",

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

        message:
          "Customer details could not be verified. Please check the entered details and try again",

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
    // status=Success|Failed filters the list (tabs in the partner UI).
    const { bureau, status } = req.query;

    // Base filter
    const filter = {
      userId: userId,
    };

    // Agar bureau diya gaya hai tab sirf us bureau ke reports fetch karo
    if (bureau) {
      filter.bureau = bureau;
    }
    if (status && status !== "All") {
      filter.status = status;
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
