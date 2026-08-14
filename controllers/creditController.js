const axios = require("axios");
const fs = require("fs");
const path = require("path");
const CreditReport = require("../models/creditReport");

// =====================================================
// RS FINTECH CONFIGURATION
// =====================================================

const RSFINTECH_CONFIG = {
  BASE_URL: process.env.RSFINTECH_BASE_URL || "https://api.rsfintech.in",

  API_KEY: process.env.RSFINTECH_API_KEY,

  TIMEOUT: 60000,
};

// =====================================================
// BUREAU ENDPOINTS
// =====================================================

const BUREAU_ENDPOINTS = {
  CIBIL: "/cibil",
  CRIF: "/crif",
  EQUIFAX: "/equifax",
  EXPERIAN: "/experian",
};

// =====================================================
// AXIOS CLIENT
// =====================================================

const rsFintechClient = axios.create({
  baseURL: RSFINTECH_CONFIG.BASE_URL,
  timeout: RSFINTECH_CONFIG.TIMEOUT,

  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${RSFINTECH_CONFIG.API_KEY}`,
  },
});

// =====================================================
// RETRY LOGIC
// =====================================================

const retryRequest = async (fn, maxAttempts = 3) => {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[RS FINTECH] Attempt ${attempt}/${maxAttempts}`);

      return await fn();
    } catch (error) {
      lastError = error;

      const retryableStatuses = [408, 429, 500, 502, 503, 504];

      const isRetryableStatus = retryableStatuses.includes(
        error.response?.status,
      );

      const isRetryableError =
        error.code === "ECONNABORTED" ||
        error.code === "ETIMEDOUT" ||
        error.code === "ENOTFOUND" ||
        error.code === "ECONNREFUSED";

      const isRetryable = isRetryableStatus || isRetryableError;

      // Don't retry non-retryable errors
      // or after final attempt
      if (!isRetryable || attempt === maxAttempts) {
        throw error;
      }

      const delay = 1000 * Math.pow(2, attempt - 1);

      console.log(`[RS FINTECH] Retrying after ${delay}ms`);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
};

// =====================================================
// ERROR HANDLER
// =====================================================

const handleError = (error) => {
  const statusCode = error?.response?.status;

  const data = error?.response?.data;

  const message = data?.message || error?.message || "RS Fintech API error";

  console.error(
    "[RS FINTECH] Error:",
    JSON.stringify(data || message, null, 2),
  );

  // ============================================
  // TIMEOUT
  // ============================================

  if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
    return {
      statusCode: 504,
      message: "RS Fintech request timed out",
      errorType: "TIMEOUT",
    };
  }

  // ============================================
  // NETWORK
  // ============================================

  if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED") {
    return {
      statusCode: 503,
      message: "Unable to connect to RS Fintech",
      errorType: "NETWORK",
    };
  }

  // ============================================
  // HTTP 403
  // ============================================

  if (statusCode === 403) {
    return {
      statusCode: 403,
      message: "RS Fintech API limit exceeded",
      errorType: "API_ACCESS_LIMIT",
    };
  }

  // ============================================
  // HTTP 500
  // ============================================

  if (statusCode === 500) {
    return {
      statusCode: 502,
      message: "RS Fintech internal server error",
      errorType: "INTERNAL_SERVER_ERROR",
    };
  }

  // ============================================
  // HTTP 400 / CIBIL BUSINESS ERRORS
  // ============================================

  if (statusCode === 400) {
    const errorCode = data?.message || data?.error || "CIBIL_ERROR";

    switch (errorCode) {
      case "INVALID_OFFER_ID":
        return {
          statusCode: 400,
          message: "Invalid offer ID",
          errorType: "INVALID_OFFER_ID",
        };

      case "DUPLICATE_PARTNER_CUST_CODE":
        return {
          statusCode: 400,
          message: "Duplicate partner customer code",
          errorType: "DUPLICATE_PARTNER_CUST_CODE",
        };

      case "SSN_EXISTS":
        return {
          statusCode: 400,
          message: "Customer already exists",
          errorType: "SSN_EXISTS",
        };

      case "SSN_EXISTS_ACTIVE_ONLINE":
        return {
          statusCode: 400,
          message: "An active CIBIL offer already exists for this customer",
          errorType: "SSN_EXISTS_ACTIVE_ONLINE",
        };

      case "BLACKLISTED_CUSTOMER":
        return {
          statusCode: 400,
          message: "Customer is blacklisted",
          errorType: "BLACKLISTED_CUSTOMER",
        };

      case "FAILURE":
        return {
          statusCode: 400,
          message: "CIBIL report generation failed",
          errorType: "FAILURE",
        };

      case "FATAL":
        return {
          statusCode: 500,
          message: "CIBIL service encountered an internal error",
          errorType: "FATAL",
        };

      case "AGE_RESTRICTION":
        return {
          statusCode: 400,
          message: "Customer does not satisfy the CIBIL age requirement",
          errorType: "AGE_RESTRICTION",
        };

      case "NO_HIT":
        return {
          statusCode: 400,
          message: "No CIBIL record found for the provided customer details",
          errorType: "NO_HIT",
        };

      case "SERVICE_ERROR":
        return {
          statusCode: 400,
          message: "CIBIL validation/service error",
          errorType: "SERVICE_ERROR",
        };

      case "PARTNER_CUST_CODE_NOT_FOUND":
        return {
          statusCode: 400,
          message: "Partner customer code not found",
          errorType: "PARTNER_CUST_CODE_NOT_FOUND",
        };

      case "LEGAL_COPY_NOT_FOUND":
        return {
          statusCode: 400,
          message: "Customer consent is missing",
          errorType: "LEGAL_COPY_NOT_FOUND",
        };

      case "INVALID_AUTH_DATA":
        return {
          statusCode: 401,
          message: "Invalid RS Fintech authentication data",
          errorType: "INVALID_AUTH_DATA",
        };

      case "SSN_MISMATCH":
        return {
          statusCode: 400,
          message: "Customer details do not match CIBIL records",
          errorType: "SSN_MISMATCH",
        };

      case "API_ACCESS_NOT_ALLOWED":
        return {
          statusCode: 403,
          message: "CIBIL API access is not allowed or consent was revoked",
          errorType: "API_ACCESS_NOT_ALLOWED",
        };

      default:
        return {
          statusCode: 400,
          message,
          errorType: errorCode,
        };
    }
  }

  // ============================================
  // UNKNOWN
  // ============================================

  return {
    statusCode: 500,
    message,
    errorType: "UNKNOWN",
  };
};

// =====================================================
// FETCH CREDIT REPORT FROM RS FINTECH
// =====================================================

const fetchCreditReportFromAPI = async (bureau, payload) => {
  const endpoint = BUREAU_ENDPOINTS[bureau];

  if (!endpoint) {
    throw new Error(`Unsupported bureau: ${bureau}`);
  }

  if (!RSFINTECH_CONFIG.API_KEY) {
    throw new Error("RS Fintech API key is not configured");
  }

  console.log(`[${bureau}] Calling RS Fintech`);
  console.log(`[${bureau}] URL:`, `${RSFINTECH_CONFIG.BASE_URL}${endpoint}`);

  console.log(`[${bureau}] Payload:`, JSON.stringify(payload, null, 2));

  try {
    const response = await rsFintechClient.post(endpoint, payload);

    console.log(`[${bureau}] HTTP Status:`, response.status);

    console.log(
      `[${bureau}] Response:`,
      JSON.stringify(response.data, null, 2),
    );

    const data = response.data;

    // ============================================
    // RS FINTECH APPLICATION-LEVEL ERROR
    // ============================================

    if (data?.status === false) {
      const error = new Error(data?.message || "RS Fintech API failed");

      error.response = {
        status: response.status,
        data,
      };

      throw error;
    }

    // ============================================
    // SUCCESS
    // ============================================

    return data;
  } catch (error) {
    console.error(
      `[${bureau}] RS Fintech request failed:`,
      JSON.stringify(error?.response?.data || error.message, null, 2),
    );

    throw error;
  }
};

// =====================================================
// GET CIBIL REPORT
// =====================================================

const getCibilReport = async (req, res) => {
  try {
    // ============================================
    // STEP 1: FRONTEND REQUEST
    // ============================================

    const { firstName, lastName, mobile, pan, gender, reportType, consent } =
      req.body;

    console.log("[CIBIL] Frontend Request:", {
      firstName,
      lastName,
      mobile,
      pan,
      gender,
      reportType,
      consent,
    });

    // ============================================
    // STEP 2: VALIDATION
    // ============================================

    if (!firstName?.trim()) {
      return res.status(400).json({
        success: false,
        message: "First name is required",
      });
    }

    if (!lastName?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Last name is required",
      });
    }

    if (!mobile?.toString().trim()) {
      return res.status(400).json({
        success: false,
        message: "Mobile number is required",
      });
    }

    if (!pan?.trim()) {
      return res.status(400).json({
        success: false,
        message: "PAN is required",
      });
    }

    // ============================================
    // STEP 3: NORMALIZE DATA
    // ============================================

    const cleanFirstName = firstName.trim();

    const cleanLastName = lastName.trim();

    const cleanMobile = String(mobile).trim();

    const cleanPan = String(pan).trim().toUpperCase();

    const name = `${cleanFirstName} ${cleanLastName}`;

    // ============================================
    // STEP 4: NORMALIZE CONSENT
    // ============================================

    const finalConsent =
      consent === true ||
      consent === "true" ||
      consent === "Y" ||
      consent === "y"
        ? "Y"
        : "N";

    if (finalConsent !== "Y") {
      return res.status(400).json({
        success: false,
        message: "Customer consent is required",
        error: "LEGAL_COPY_NOT_FOUND",
      });
    }

    // ============================================
    // STEP 5: RS FINTECH PAYLOAD
    // ============================================

    const rsFintechPayload = {
      name,
      pan: cleanPan,
      mobile: cleanMobile,
      consent: "Y",
    };

    console.log(
      "[RS FINTECH] CIBIL Payload:",
      JSON.stringify(rsFintechPayload, null, 2),
    );

    // ============================================
    // STEP 6: CALL RS FINTECH
    // ============================================

    let apiData;

    try {
      apiData = await fetchCreditReportFromAPI("CIBIL", rsFintechPayload);
    } catch (apiError) {
      const errorInfo = handleError(apiError);

      console.error("[CIBIL] RS Fintech Error:", errorInfo);

      return res.status(errorInfo.statusCode).json({
        success: false,
        message: errorInfo.message,
        error: errorInfo.errorType,

        requestId: apiError?.response?.data?.requestId || null,
      });
    }

    // ============================================
    // STEP 7: LOG RESPONSE
    // ============================================

    console.log(
      "[RS FINTECH] CIBIL Response:",
      JSON.stringify(apiData, null, 2),
    );

    // ============================================
    // STEP 8: REQUEST ID
    // ============================================

    const requestId = apiData?.requestId || null;

    // ============================================
    // STEP 9: CIBIL RESPONSE
    // ============================================

    const cibilResponse = apiData?.response?.GetCustomerAssetsResponse;

    if (!cibilResponse) {
      return res.status(502).json({
        success: false,
        message: "Invalid CIBIL response from RS Fintech",
        error: "INVALID_CIBIL_RESPONSE",
        requestId,
      });
    }

    // ============================================
    // STEP 10: CIBIL SUCCESS DATA
    // ============================================

    const cibilSuccess = cibilResponse?.GetCustomerAssetsSuccess;

    if (!cibilSuccess) {
      return res.status(502).json({
        success: false,
        message: "CIBIL report data not found",
        error: "CIBIL_DATA_NOT_FOUND",
        requestId,
      });
    }

    // ============================================
    // STEP 11: SCORE EXTRACTION
    // ============================================

    const findDeepValue = (obj, keys) => {
      if (!obj || typeof obj !== "object") {
        return null;
      }

      if (Array.isArray(obj)) {
        for (const item of obj) {
          const result = findDeepValue(item, keys);

          if (result !== null && result !== undefined) {
            return result;
          }
        }

        return null;
      }

      for (const [key, value] of Object.entries(obj)) {
        if (
          keys.includes(key) &&
          value !== null &&
          value !== undefined &&
          value !== ""
        ) {
          return value;
        }

        if (value && typeof value === "object") {
          const result = findDeepValue(value, keys);

          if (result !== null && result !== undefined) {
            return result;
          }
        }
      }

      return null;
    };

    const rawScore = findDeepValue(cibilSuccess, [
      "riskScore",
      "RiskScore",
      "score",
      "Score",
    ]);

    let score = null;

    if (rawScore !== null && rawScore !== undefined && rawScore !== "") {
      const numericScore = Number(rawScore);

      if (!Number.isNaN(numericScore)) {
        score = numericScore;
      }
    }

    // ============================================
    // STEP 12: REPORT URL
    // ============================================

    const reportUrl = apiData?.response?.htmlLink || null;

    console.log("[RS FINTECH] Request ID:", requestId);

    console.log("[RS FINTECH] Score:", score);

    console.log("[RS FINTECH] Report URL:", reportUrl);

    // ============================================
    // STEP 13: SAVE DATABASE
    // ============================================

    const creditReport = new CreditReport({
      name,

      firstName: cleanFirstName,

      lastName: cleanLastName,

      mobile: cleanMobile,

      pan: cleanPan,

      gender: gender || null,

      reportType: reportType || "cibil",

      score,

      bureau: "cibil",

      reportData: apiData,

      reportUrl,
    });

    await creditReport.save();

    console.log("[RS FINTECH] Credit report saved:", creditReport._id);

    // ============================================
    // STEP 14: SUCCESS
    // ============================================

    return res.status(200).json({
      success: true,

      message: "CIBIL report retrieved successfully from RS Fintech",

      requestId,

      creditReport: {
        id: creditReport._id,

        name: creditReport.name,

        firstName: cleanFirstName,

        lastName: cleanLastName,

        mobile: creditReport.mobile,

        pan: creditReport.pan,

        gender: creditReport.gender,

        reportType: creditReport.reportType,

        score: creditReport.score,

        bureau: creditReport.bureau,

        reportUrl: creditReport.reportUrl,

        localPath: creditReport.localPath || null,

        createdAt: creditReport.createdAt,
      },
    });
  } catch (error) {
    console.error("[CIBIL] Controller Error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

/**
 * GET CRIF REPORT
 * POST /api/credit/crif
 */
const getCrifReport = async (req, res) => {
  try {
    const { name, mobile, pan, consent = "Y" } = req.body;

    console.log("[CRIF] Request received from:", name);

    // Step 1: Fetch from API
    const apiResponse = await fetchCreditReportFromAPI("CRIF", {
      name,
      mobile,
      pan,
      consent,
    });

    // Step 2: Save to database
    const creditReport = await saveCreditReportToDB({
      name,
      mobile,
      pan,
      bureau: "CRIF",
      apiResponse,
    });

    // Step 3: Return success response
    console.log("[CRIF] Sending success response");
    return sendSuccess(res, "CIBIL report fetched successfully", {
      reportId: creditReport._id,

      creditScore:
        creditReport.riskScore !== null && creditReport.riskScore !== undefined
          ? creditReport.riskScore
          : null,

      rating:
        creditReport.rating !== null && creditReport.rating !== undefined
          ? creditReport.rating
          : null,

      reportUrl:
        creditReport.reportUrl !== null && creditReport.reportUrl !== undefined
          ? creditReport.reportUrl
          : null,

      bureau: "CIBIL",
    });
  } catch (error) {
    const errorInfo = handleError(error, "CRIF");
    return sendError(res, errorInfo.message, errorInfo.statusCode);
  }
};

/**
 * GET EQUIFAX REPORT
 * POST /api/credit/equifax
 */
const getEquifaxReport = async (req, res) => {
  try {
    const {
      name,
      id_number,
      id_type,
      mobile,
      gender,
      consent = "Y",
    } = req.body;

    //   NOTE: Validation is done by middleware
    console.log("[EQUIFAX] Request received from:", name);

    // Step 1: Fetch from API
    const apiResponse = await fetchCreditReportFromAPI("EQUIFAX", {
      name,
      id_number,
      id_type,
      mobile,
      gender,
      consent,
    });

    // Step 2: Save to database
    const creditReport = await saveCreditReportToDB({
      name,
      mobile,
      idNumber: id_number,
      bureau: "EQUIFAX",
      apiResponse,
    });

    // Step 3: Return success response
    console.log("[EQUIFAX] Sending success response");
    return sendSuccess(res, "EQUIFAX report fetched successfully", {
      reportId: creditReport._id,
      creditScore: creditReport.score,
      rating: creditReport.rating,
      reportUrl: creditReport.reportUrl,
      bureau: "EQUIFAX",
    });
  } catch (error) {
    const errorInfo = handleError(error, "EQUIFAX");
    return sendError(res, errorInfo.message, errorInfo.statusCode);
  }
};

/**
 * GET EXPERIAN REPORT
 * POST /api/credit/experian
 */
const getExperianReport = async (req, res) => {
  try {
    const { name, mobile, pan, consent = "Y" } = req.body;

    console.log("[EXPERIAN] Request received from:", name);

    // Step 1: Fetch from API
    const apiResponse = await fetchCreditReportFromAPI("EXPERIAN", {
      name,
      mobile,
      pan,
      consent,
    });

    // Step 2: Save to database
    const creditReport = await saveCreditReportToDB({
      name,
      mobile,
      pan,
      bureau: "EXPERIAN",
      apiResponse,
    });

    // Step 3: Return success response
    console.log("[EXPERIAN] Sending success response");
    return sendSuccess(res, "EXPERIAN report fetched successfully", {
      reportId: creditReport._id,
      creditScore: creditReport.score,
      rating: creditReport.rating,
      reportUrl: creditReport.reportUrl,
      bureau: "EXPERIAN",
    });
  } catch (error) {
    const errorInfo = handleError(error, "EXPERIAN");
    return sendError(res, errorInfo.message, errorInfo.statusCode);
  }
};

// ==================== EXPORT ====================
module.exports = {
  getCibilReport,
  getCrifReport,
  getEquifaxReport,
  getExperianReport,
};
