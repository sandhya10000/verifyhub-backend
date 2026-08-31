const axios = require("axios");
const fs = require("fs");
const path = require("path");
const CreditReport = require("../models/creditReport");
const config = require("../config/bureau.config");

const SUREPASS_CONFIG = require("../config/surepass");
const saveCreditReportLocally = require("../utils/saveCreditReportLocally");

const CibilReportFromDigi = async (req, res) => {
  let creditReport = null;

  try {
    // ============================================
    // STEP 1: AUTHENTICATED USER
    // ============================================

    const userId = req.user?._id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User authentication required",
      });
    }

    console.log("[CIBIL] Authenticated User:", userId);

    // ============================================
    // STEP 2: FRONTEND REQUEST
    // ============================================

    const {
      firstName,
      lastName,
      mobile,
      pan,
      gender,
      reportType,
      consent,
      orderId,
    } = req.body;

    console.log("[CIBIL] Frontend Request:", {
      firstName,
      lastName,
      mobile,
      pan,
      gender,
      reportType,
      consent,
      orderId,
    });

    // ============================================
    // STEP 3: VALIDATION
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
    // STEP 4: NORMALIZE DATA
    // ============================================

    const cleanFirstName = String(firstName).trim();
    const cleanLastName = String(lastName).trim();
    const cleanMobile = String(mobile).trim();
    const cleanPan = String(pan).trim().toUpperCase();

    const name = `${cleanFirstName} ${cleanLastName}`;

    // ============================================
    // STEP 5: CONSENT
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
    // STEP 6: DIGI V7 PAYLOAD
    // ============================================

    const digiPayload = {
      consent: "Y",
    };

    console.log(
      "[DIGI] CIBIL V7 Payload:",
      JSON.stringify(digiPayload, null, 2),
    );

    // ============================================
    // STEP 7: DIGI URL
    // ============================================

    const digiBaseUrl = process.env.DIGI_BASE_URL?.trim();

    if (!digiBaseUrl) {
      return res.status(500).json({
        success: false,
        message: "DIGI_BASE_URL is missing",
        error: "DIGI_BASE_URL_MISSING",
      });
    }

    const digiUrl = `${digiBaseUrl}/api/v7/cibil-bureau-report`;

    console.log("[DIGI] API URL:", digiUrl);

    // ============================================
    // STEP 8: DIGI TOKEN
    // ============================================

    const digiToken = process.env.DIGI_API_TOKEN?.trim();

    console.log("[DIGI] Token Status:", digiToken ? "FOUND" : "MISSING");

    console.log("[DIGI] Token Length:", digiToken?.length || 0);

    if (!digiToken) {
      return res.status(500).json({
        success: false,
        message: "DIGI API token is missing",
        error: "DIGI_TOKEN_MISSING",
      });
    }

    // ============================================
    // STEP 9: CREATE PENDING CREDIT REPORT
    // ============================================

    creditReport = await CreditReport.create({
      userId,

      orderId: orderId ? String(orderId).trim() : null,

      name,

      firstName: cleanFirstName,

      lastName: cleanLastName,

      mobile: cleanMobile,

      pan: cleanPan,

      gender: gender || null,

      reportType: reportType || "cibil",

      score: null,

      bureau: "cibil",

      consent: "Y",

      status: "Pending",

      reportUrl: null,

      localPath: null,

      reportData: null,

      isPublic: false,
    });

    console.log("[DIGI] Pending Credit Report Created:", creditReport._id);

    // ============================================
    // STEP 10: CALL DIGI V7 API
    // ============================================

    let digiResponse;

    try {
      digiResponse = await axios.post(digiUrl, digiPayload, {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",

          Authorization: `Bearer ${digiToken}`,
        },

        timeout: 60000,
      });

      console.log(
        "[DIGI] API SUCCESS:",
        JSON.stringify(digiResponse.data, null, 2),
      );
    } catch (apiError) {
      const httpStatus = apiError.response?.status || null;

      const digiError = apiError.response?.data || null;

      console.error("[DIGI] HTTP STATUS:", httpStatus);

      console.error(
        "[DIGI] API ERROR:",
        JSON.stringify(digiError || apiError.message, null, 2),
      );

      // ==========================================
      // UPDATE PENDING -> FAILED
      // ==========================================

      creditReport.status = "Failed";

      creditReport.reportData = {
        error: digiError || apiError.message,
      };

      await creditReport.save();

      // ==========================================
      // INVALID TOKEN
      // ==========================================

      const errorMessage =
        typeof digiError?.message === "string"
          ? digiError.message.toLowerCase()
          : "";

      if (
        httpStatus === 401 ||
        errorMessage.includes("invalid token") ||
        errorMessage.includes("unauthorized")
      ) {
        return res.status(401).json({
          success: false,

          message: "DIGI authentication failed",

          error: digiError?.message || "Invalid DIGI API token",

          creditReportId: creditReport._id,

          userId: creditReport.userId,

          status: creditReport.status,

          digiResponse: digiError,
        });
      }

      // ==========================================
      // TIMEOUT
      // ==========================================

      if (apiError.code === "ECONNABORTED" || apiError.code === "ETIMEDOUT") {
        return res.status(504).json({
          success: false,

          message: "DIGI CIBIL request timed out",

          error: "TIMEOUT",

          creditReportId: creditReport._id,

          userId: creditReport.userId,

          status: creditReport.status,
        });
      }

      // ==========================================
      // NETWORK ERROR
      // ==========================================

      if (apiError.code === "ENOTFOUND" || apiError.code === "ECONNREFUSED") {
        return res.status(503).json({
          success: false,

          message: "Unable to connect to DIGI CIBIL API",

          error: "NETWORK_ERROR",

          creditReportId: creditReport._id,

          userId: creditReport.userId,

          status: creditReport.status,
        });
      }

      // ==========================================
      // OTHER DIGI ERROR
      // ==========================================

      return res.status(httpStatus || 502).json({
        success: false,

        message: "DIGI CIBIL API request failed",

        creditReportId: creditReport._id,

        userId: creditReport.userId,

        status: creditReport.status,

        error: digiError || apiError.message,
      });
    }

    // ============================================
    // STEP 11: DIGI RESPONSE
    // ============================================

    const apiData = digiResponse?.data;

    console.log("[DIGI] CIBIL Response:", JSON.stringify(apiData, null, 2));

    if (!apiData) {
      creditReport.status = "Failed";

      creditReport.reportData = {
        error: "EMPTY_DIGI_RESPONSE",
      };

      await creditReport.save();

      return res.status(502).json({
        success: false,

        message: "Empty response received from DIGI",

        error: "EMPTY_DIGI_RESPONSE",

        creditReportId: creditReport._id,

        userId: creditReport.userId,
      });
    }

    // ============================================
    // STEP 12: BASIC RESPONSE
    // ============================================

    const digiStatus = apiData?.status ?? false;

    const digiMessage = apiData?.message || null;

    const statusCode = apiData?.status_code || null;

    // ============================================
    // STEP 13: CIBIL RESPONSE
    // ============================================

    const cibilResponse = apiData?.data?.GetCustomerAssetsResponse || null;

    const cibilSuccess = cibilResponse?.GetCustomerAssetsSuccess || null;

    // ============================================
    // STEP 14: RESPONSE DETAILS
    // ============================================

    const responseStatus = cibilResponse?.ResponseStatus || null;

    const responseKey = cibilResponse?.ResponseKey || null;

    // ============================================
    // STEP 15: ASSET
    // ============================================

    const assetId = cibilSuccess?.AssetId || null;

    const asset = cibilSuccess?.Asset || null;

    const assetStatus = asset?.Status || null;

    const creationDate = asset?.CreationDate || null;

    const expirationDate = asset?.ExpirationDate || null;

    const safetyCheckFailure = asset?.SafetyCheckFailure ?? null;

    // ============================================
    // STEP 16: CREDIT SUMMARY
    // ============================================

    const creditSummary = cibilSuccess?.CreditSummaryData || null;

    const oldestCreditAccountPeriod =
      creditSummary?.OldestCreditAccountPeriod || null;

    const inquiries = creditSummary?.Inquires || null;

    const onTimePaymentHistory = creditSummary?.OnTimePaymentHistory || null;

    const creditCardUtilization = creditSummary?.CreditCardUtilization || null;

    const creditMix = creditSummary?.CreditMix || null;

    // ============================================
    // STEP 17: SCORE
    // ============================================

    let score = null;

    const possibleScore =
      apiData?.credit_score ??
      apiData?.data?.credit_score ??
      apiData?.data?.score ??
      apiData?.data?.CreditScore ??
      cibilSuccess?.CreditScore ??
      null;

    if (
      possibleScore !== null &&
      possibleScore !== undefined &&
      possibleScore !== ""
    ) {
      const numericScore = Number(possibleScore);

      if (!Number.isNaN(numericScore)) {
        score = numericScore;
      }
    }

    // ============================================
    // STEP 18: REPORT URL
    // ============================================

    const reportUrl =
      apiData?.data?.htmlLink ||
      apiData?.reportUrl ||
      apiData?.pdfUrl ||
      apiData?.data?.reportUrl ||
      apiData?.data?.pdfUrl ||
      null;

    // ============================================
    // STEP 19: LOG DATA
    // ============================================

    console.log("[DIGI] Status:", digiStatus);

    console.log("[DIGI] Status Code:", statusCode);

    console.log("[DIGI] Message:", digiMessage);

    console.log("[DIGI] Response Status:", responseStatus);

    console.log("[DIGI] Response Key:", responseKey);

    console.log("[DIGI] Asset ID:", assetId);

    console.log("[DIGI] Score:", score);

    console.log("[DIGI] Report URL:", reportUrl);

    // ============================================
    // STEP 20: SUCCESS CHECK
    // ============================================

    if (digiStatus !== true || responseStatus !== "Success") {
      creditReport.status = "Failed";

      creditReport.reportData = apiData;

      creditReport.reportUrl = reportUrl || null;

      await creditReport.save();

      return res.status(400).json({
        success: false,

        message: digiMessage || "CIBIL report generation failed",

        error: "CIBIL_REPORT_FAILED",

        statusCode,

        responseStatus,

        responseKey,

        creditReportId: creditReport._id,

        userId: creditReport.userId,

        status: creditReport.status,
      });
    }

    // ============================================
    // STEP 21: SAVE REPORT LOCALLY
    // ============================================

    let localPath = null;

    if (reportUrl) {
      try {
        localPath = await saveCreditReportLocally(
          reportUrl,

          creditReport._id.toString(),

          "cibil",

          "pdf",
        );

        console.log("[DIGI] CIBIL Report saved locally:", localPath);
      } catch (fileError) {
        console.error("[DIGI] Local report save failed:", fileError.message);

        // File save fail hone par API report
        // ko Failed nahi karenge.
        // localPath null rahega.
      }
    } else {
      console.log("[DIGI] No report URL received");
    }

    // ============================================
    // STEP 22: UPDATE CREDIT REPORT
    // ============================================

    creditReport.score = score;

    creditReport.bureau = "cibil";

    creditReport.reportUrl = reportUrl;

    creditReport.localPath = localPath;

    creditReport.reportData = apiData;

    creditReport.status = "Success";

    await creditReport.save();

    console.log("[DIGI] Credit Report Updated:", creditReport._id);

    // ============================================
    // STEP 23: SUCCESS RESPONSE
    // ============================================

    return res.status(200).json({
      success: true,

      message: digiMessage || "CIBIL report retrieved successfully from DIGI",

      statusCode,

      responseStatus,

      creditReport: {
        id: creditReport._id,

        creditReportId: creditReport._id,

        userId: creditReport.userId,

        orderId: creditReport.orderId,

        name: creditReport.name,

        firstName: creditReport.firstName,

        lastName: creditReport.lastName,

        mobile: creditReport.mobile,

        pan: creditReport.pan,

        gender: creditReport.gender,

        reportType: creditReport.reportType,

        score: creditReport.score,

        bureau: creditReport.bureau,

        status: creditReport.status,

        reportId: creditReport.reportId || null,

        reportUrl: creditReport.reportUrl,

        localPath: creditReport.localPath || null,

        responseKey,

        assetId,

        assetStatus,

        creationDate,

        expirationDate,

        safetyCheckFailure,

        creditSummary: {
          oldestCreditAccountPeriod,

          inquiries,

          onTimePaymentHistory,

          creditCardUtilization,

          creditMix,
        },

        createdAt: creditReport.createdAt,
      },
    });
  } catch (error) {
    // ============================================
    // STEP 24: UNKNOWN ERROR
    // ============================================

    console.error("[CIBIL] Controller Error:", error.message);

    // ============================================
    // UPDATE PENDING -> FAILED
    // ============================================

    if (creditReport) {
      try {
        creditReport.status = "Failed";

        creditReport.reportData = {
          error: error.response?.data || error.message,
        };

        await creditReport.save();
      } catch (dbError) {
        console.error(
          "[CIBIL] Failed to update report status:",
          dbError.message,
        );
      }
    }

    // ============================================
    // AXIOS ERROR
    // ============================================

    if (error.response) {
      return res.status(error.response.status || 500).json({
        success: false,

        message: "CIBIL API request failed",

        creditReportId: creditReport?._id || null,

        userId: creditReport?.userId || null,

        status: creditReport?.status || "Failed",

        error: error.response.data,
      });
    }

    // ============================================
    // NO RESPONSE
    // ============================================

    if (error.request) {
      return res.status(504).json({
        success: false,

        message: "CIBIL API did not respond",

        creditReportId: creditReport?._id || null,

        userId: creditReport?.userId || null,

        status: creditReport?.status || "Failed",

        errorCode: error.code,

        errorMessage: error.message,
      });
    }

    // ============================================
    // INTERNAL ERROR
    // ============================================

    return res.status(500).json({
      success: false,

      message: "Server error",

      creditReportId: creditReport?._id || null,

      userId: creditReport?.userId || null,

      status: creditReport?.status || "Failed",

      error: error.message,
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

      return res.status(200).json({
        success: true,
        message: "CRIF report fetched successfully",

        creditReportId: creditReport._id,
        userId: creditReport.userId,
        reportId: creditReport.reportId,
        orderId: creditReport.orderId,

        score: creditReport.score,
        status: creditReport.status,

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

      return res.status(400).json({
        success: false,
        message: apiData?.message || "CRIF report request failed",

        creditReportId: creditReport._id,

        status: creditReport.status,

        data: apiData,
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
      apiData.score !== undefined &&
      apiData.score !== null &&
      apiData.score !== ""
    ) {
      const parsedScore = Number(apiData.score);

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
    // STEP 17: SAVE REPORT LOCALLY
    // ============================================================

    let localPath = null;

    if (reportUrl) {
      try {
        localPath = await saveCreditReportLocally(
          reportUrl,
          creditReport._id.toString(),
          "crif",
          "pdf",
        );

        console.log("[CRIF] Report saved locally:", localPath);
      } catch (fileError) {
        console.error("[CRIF] Local report save failed:", fileError.message);
      }
    }

    // ============================================================
    // STEP 18: UPDATE DATABASE
    // ============================================================

    creditReport.reportId = crifReportId;

    creditReport.score = score;

    creditReport.reportUrl = reportUrl;

    creditReport.localPath = localPath;

    creditReport.reportData = apiData;

    creditReport.status = "Success";

    await creditReport.save();

    // ============================================================
    // STEP 19: RESPONSE
    // ============================================================

    return res.status(200).json({
      success: true,

      message: "CRIF report fetched successfully",

      creditReportId: creditReport._id,

      userId: creditReport.userId,

      reportId: creditReport.reportId,

      orderId: creditReport.orderId,

      score: creditReport.score,

      status: creditReport.status,

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

      return res.status(error.response.status || 500).json({
        success: false,

        message: "CRIF API request failed",

        creditReportId: creditReport?._id || null,

        status: creditReport?.status || "Failed",

        error: error.response.data,
      });
    }

    // ============================================================
    // NO RESPONSE
    // ============================================================

    if (error.request) {
      return res.status(504).json({
        success: false,

        message: "CRIF API did not respond",

        creditReportId: creditReport?._id || null,

        status: creditReport?.status || "Failed",
      });
    }

    // ============================================================
    // INTERNAL ERROR
    // ============================================================

    return res.status(500).json({
      success: false,

      message: "Internal server error",

      creditReportId: creditReport?._id || null,

      status: creditReport?.status || "Failed",

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

      mobile: mobile,

      pan: pan,

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

      return res.status(502).json({
        success: false,
        message: "Invalid response from Experian API",

        creditReportId: creditReport._id,

        userId: creditReport.userId,

        status: creditReport.status,

        response: apiData,
      });
    }

    // ============================================================
    // 17. API FAILED
    // ============================================================

    if (!verify.ok) {
      creditReport.status = "Failed";

      creditReport.reportData = apiData;

      await creditReport.save();

      return res.status(400).json({
        success: false,

        message: verify.message || "Experian verification failed",

        creditReportId: creditReport._id,

        userId: creditReport.userId,

        status: creditReport.status,

        error: verify.error || null,

        result: verify.result || null,
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
    // 22. EXPERIAN REPORT URL
    // ============================================================

    const reportUrl = result?.excelExperianReport || null;

    console.log(
      "[EXPERIAN] Report URL:",
      reportUrl ? "Available" : "Not Available",
    );

    // ============================================================
    // 23. SAVE REPORT LOCALLY
    // ============================================================

    let localPath = null;

    if (reportUrl) {
      try {
        localPath = await saveCreditReportLocally(
          reportUrl,
          creditReport._id.toString(),
          "EXPERIAN",
          "xlsx",
        );

        console.log("[EXPERIAN] Report saved locally:", localPath);
      } catch (fileError) {
        console.error(
          "[EXPERIAN] Local report save failed:",
          fileError.message,
        );

        // File save fail hone par API report ko Failed
        // karna zaroori nahi hai.
        // API successfully report de chuki hai.
      }
    }

    // ============================================================
    // 24. UPDATE CREDIT REPORT
    // ============================================================

    creditReport.score = score;

    creditReport.reportUrl = reportUrl;

    creditReport.localPath = localPath;

    creditReport.reportData = apiData;

    creditReport.status = "Success";

    // Optional fields agar schema mein available hain
    // creditReport.reportNumber = reportNumber;

    await creditReport.save();

    console.log("[EXPERIAN] Credit Report Updated:", creditReport._id);

    // ============================================================
    // 25. FINAL RESPONSE
    // ============================================================

    return res.status(200).json({
      success: true,

      message: verify.message || "Experian report generated successfully",

      creditReportId: creditReport._id,

      userId: creditReport.userId,

      reportId: creditReport.reportId || reportNumber,

      orderId: creditReport.orderId,

      status: creditReport.status,

      score: creditReport.score,

      scoreConfidence,

      exactMatch,

      reportNumber,

      reportDate,

      reportTime,

      version,

      reportUrl: creditReport.reportUrl,

      localPath: creditReport.localPath,

      data: {
        header: result?.Header || null,

        userMessage: result?.UserMessage || null,

        totalCAPS: result?.TotalCAPS_Summary || null,

        caisAccount: result?.CAIS_Account || null,

        caps: result?.CAPS || null,

        nonCreditCAPS: result?.NonCreditCAPS || null,

        currentApplication: result?.Current_Application || null,

        excelExperianReport: result?.excelExperianReport || null,
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

      return res.status(error.response.status || 500).json({
        success: false,

        message: "Experian API request failed",

        creditReportId: creditReport?._id || null,

        userId: creditReport?.userId || null,

        status: creditReport?.status || "Failed",

        error: error.response.data,
      });
    }

    // ============================================================
    // NO RESPONSE
    // ============================================================

    if (error.request) {
      return res.status(504).json({
        success: false,

        message: "Experian API did not respond",

        creditReportId: creditReport?._id || null,

        userId: creditReport?.userId || null,

        status: creditReport?.status || "Failed",
      });
    }

    // ============================================================
    // INTERNAL ERROR
    // ============================================================

    return res.status(500).json({
      success: false,

      message: "Internal server error",

      creditReportId: creditReport?._id || null,

      userId: creditReport?.userId || null,

      status: creditReport?.status || "Failed",

      error: error.message,
    });
  }
};

const EquifaxReport = async (req, res) => {
  let creditReport = null;

  try {
    // ==========================================
    // 1. AUTHENTICATED USER
    // ==========================================

    const userId = req.user?._id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User authentication required",
      });
    }

    console.log("[EQUIFAX] Authenticated User:", userId);

    // ==========================================
    // 2. GET REQUEST DATA
    // ==========================================

    const { name, panNumber, mobile, gender, consent, orderId } = req.body;

    // ==========================================
    // 3. CONFIG VALIDATION
    // ==========================================

    if (!SUREPASS_CONFIG.baseUrl || !SUREPASS_CONFIG.apiToken) {
      console.error("[EQUIFAX] Surepass configuration missing");

      return res.status(500).json({
        success: false,
        message: "Surepass configuration is missing",
      });
    }

    // ==========================================
    // 4. VALIDATION
    // ==========================================

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

    // ==========================================
    // 5. CONSENT VALIDATION
    // ==========================================

    if (String(consent).trim().toUpperCase() !== "Y") {
      return res.status(400).json({
        success: false,
        message: "Customer consent must be Y",
      });
    }

    // ==========================================
    // 6. CLEAN DATA
    // ==========================================

    const cleanName = String(name).trim();
    const cleanPan = String(panNumber).trim().toUpperCase();
    const cleanMobile = String(mobile).trim();
    const cleanGender = String(gender).trim().toLowerCase();

    // ==========================================
    // 7. SUREPASS PAYLOAD
    // ==========================================

    const payload = {
      name: cleanName,
      id_number: cleanPan,
      id_type: "pan",
      mobile: cleanMobile,
      consent: "Y",
      gender: cleanGender,
    };

    console.log("[EQUIFAX] Request:", {
      ...payload,
      id_number: "********",
    });

    // ==========================================
    // 8. CREATE PENDING CREDIT REPORT
    // ==========================================

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

    // ==========================================
    // 9. API URL
    // ==========================================

    const apiUrl = `${SUREPASS_CONFIG.baseUrl}${SUREPASS_CONFIG.equifaxEndpoint}`;

    console.log("[EQUIFAX] API URL:", apiUrl);

    // ==========================================
    // 10. HEADERS
    // ==========================================

    const headers = {
      "Content-Type": "application/json",

      Authorization: `Bearer ${SUREPASS_CONFIG.apiToken}`,
    };

    // ==========================================
    // 11. CALL SUREPASS
    // ==========================================

    const response = await axios.post(apiUrl, payload, {
      headers,
      timeout: SUREPASS_CONFIG.timeout,
    });

    const apiData = response.data;

    console.log("[EQUIFAX] Response:", JSON.stringify(apiData, null, 2));

    // ==========================================
    // 12. CHECK API SUCCESS
    // ==========================================

    if (apiData?.success === false || apiData?.status === false) {
      creditReport.status = "Failed";

      creditReport.reportData = apiData;

      await creditReport.save();

      return res.status(400).json({
        success: false,
        message: apiData?.message || "Equifax credit report request failed",

        creditReportId: creditReport._id,

        userId: creditReport.userId,

        status: creditReport.status,

        data: apiData,
      });
    }

    // ==========================================
    // 13. GET REPORT URL
    // ==========================================

    const reportUrl =
      apiData?.reportUrl ||
      apiData?.pdfUrl ||
      apiData?.data?.reportUrl ||
      apiData?.data?.pdfUrl ||
      apiData?.data?.result?.reportUrl ||
      apiData?.data?.result?.pdfUrl ||
      null;

    console.log("[EQUIFAX] Report URL:", reportUrl);

    // ==========================================
    // 14. GET SCORE
    // ==========================================

    let score = null;

    const possibleScore =
      apiData?.score ??
      apiData?.data?.score ??
      apiData?.data?.result?.score ??
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

    // ==========================================
    // 15. GET REPORT ID
    // ==========================================

    const reportId =
      apiData?.reportId ||
      apiData?.reportID ||
      apiData?.data?.reportId ||
      apiData?.data?.reportID ||
      apiData?.data?.result?.reportId ||
      apiData?.data?.result?.reportID ||
      null;

    // ==========================================
    // 16. SAVE REPORT LOCALLY
    // ==========================================

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

        // File save fail hone par API request ko
        // failed nahi karenge.
        // Report DB me rahegi but localPath null rahega.
      }
    } else {
      console.log("[EQUIFAX] No report URL received from API");
    }

    // ==========================================
    // 17. UPDATE CREDIT REPORT
    // ==========================================

    creditReport.reportId = reportId;

    creditReport.score = score;

    creditReport.reportUrl = reportUrl;

    creditReport.localPath = localPath;

    creditReport.reportData = apiData;

    creditReport.status = "Success";

    await creditReport.save();

    console.log("[EQUIFAX] Credit Report Updated:", creditReport._id);

    // ==========================================
    // 18. FINAL RESPONSE
    // ==========================================

    return res.status(200).json({
      success: true,

      message: "Equifax credit report fetched successfully",

      creditReportId: creditReport._id,

      userId: creditReport.userId,

      reportId: creditReport.reportId,

      orderId: creditReport.orderId,

      score: creditReport.score,

      status: creditReport.status,

      reportUrl: creditReport.reportUrl,

      localPath: creditReport.localPath,

      data: creditReport,
    });
  } catch (error) {
    // ==========================================
    // 19. ERROR
    // ==========================================

    console.error("[EQUIFAX] Error:", error.message);

    // ==========================================
    // UPDATE PENDING -> FAILED
    // ==========================================

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

    // ==========================================
    // 20. API RESPONSE ERROR
    // ==========================================

    if (error.response) {
      console.error("[EQUIFAX] HTTP STATUS:", error.response.status);

      console.error(
        "[EQUIFAX] API ERROR:",
        JSON.stringify(error.response.data, null, 2),
      );

      return res.status(error.response.status || 500).json({
        success: false,

        message: "Equifax API request failed",

        creditReportId: creditReport?._id || null,

        userId: creditReport?.userId || null,

        status: creditReport?.status || "Failed",

        error: error.response.data,
      });
    }

    // ==========================================
    // 21. NO RESPONSE
    // ==========================================

    if (error.request) {
      return res.status(504).json({
        success: false,

        message: "Equifax API did not respond",

        creditReportId: creditReport?._id || null,

        userId: creditReport?.userId || null,

        status: creditReport?.status || "Failed",

        errorCode: error.code,

        errorMessage: error.message,
      });
    }

    // ==========================================
    // 22. INTERNAL ERROR
    // ==========================================

    return res.status(500).json({
      success: false,

      message: "Internal server error",

      creditReportId: creditReport?._id || null,

      userId: creditReport?.userId || null,

      status: creditReport?.status || "Failed",

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

module.exports = {
  CibilReportFromDigi,
  CrifReport,
  ExperianReport,
  EquifaxReport,
  getAllCreditReports,
};
