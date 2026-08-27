const axios = require("axios");
const fs = require("fs");
const path = require("path");
const CreditReport = require("../models/creditReport");
const config = require("../config/bureau.config");

const SUREPASS_CONFIG = require("../config/surepass");

const getCibilReportFromDigi = async (req, res) => {
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
    // STEP 4: CONSENT
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
    // STEP 5: DIGI V7 PAYLOAD
    // ============================================

    const digiPayload = {
      consent: "Y",
    };

    console.log(
      "[DIGI] CIBIL V7 Payload:",
      JSON.stringify(digiPayload, null, 2),
    );

    // ============================================
    // STEP 6: DIGI URL
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
    // STEP 7: DIGI TOKEN
    // ============================================

    // ============================================
    // STEP 8: CALL DIGI V7 API
    // ============================================

    let digiResponse;

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

    try {
      digiResponse = await axios.post(digiUrl, digiPayload, {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",

          // ======================================
          // DIGI TOKEN
          // ======================================
          Authorization: `Bearer ${digiToken}`,
        },

        timeout: 60000,
      });

      // ==========================================
      // SUCCESS LOG
      // ==========================================

      console.log(
        "[DIGI] API SUCCESS:",
        JSON.stringify(digiResponse.data, null, 2),
      );
    } catch (apiError) {
      // ==========================================
      // GET ORIGINAL DIGI ERROR
      // ==========================================

      const httpStatus = apiError.response?.status || null;

      const digiError = apiError.response?.data || null;

      console.error("[DIGI] HTTP STATUS:", httpStatus);

      console.error(
        "[DIGI] API ERROR:",
        JSON.stringify(digiError || apiError.message, null, 2),
      );

      // ==========================================
      // INVALID / UNAUTHORIZED TOKEN
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
        });
      }

      // ==========================================
      // OTHER DIGI ERROR
      // ==========================================

      return res.status(httpStatus || 502).json({
        success: false,

        message: "DIGI CIBIL API request failed",

        error: digiError || apiError.message,
      });
    }

    // ============================================
    // STEP 9: DIGI RESPONSE
    // ============================================

    const apiData = digiResponse?.data;

    console.log("[DIGI] CIBIL Response:", JSON.stringify(apiData, null, 2));

    if (!apiData) {
      return res.status(502).json({
        success: false,
        message: "Empty response received from DIGI",
        error: "EMPTY_DIGI_RESPONSE",
      });
    }

    // ============================================
    // STEP 10: BASIC RESPONSE
    // ============================================

    const digiStatus = apiData?.status ?? false;

    const digiMessage = apiData?.message || null;

    const statusCode = apiData?.status_code || null;

    // ============================================
    // STEP 11: CIBIL RESPONSE
    // ============================================

    const cibilResponse = apiData?.data?.GetCustomerAssetsResponse || null;

    const cibilSuccess = cibilResponse?.GetCustomerAssetsSuccess || null;

    // ============================================
    // STEP 12: RESPONSE DETAILS
    // ============================================

    const responseStatus = cibilResponse?.ResponseStatus || null;

    const responseKey = cibilResponse?.ResponseKey || null;

    // ============================================
    // STEP 13: ASSET
    // ============================================

    const assetId = cibilSuccess?.AssetId || null;

    const asset = cibilSuccess?.Asset || null;

    const assetStatus = asset?.Status || null;

    const creationDate = asset?.CreationDate || null;

    const expirationDate = asset?.ExpirationDate || null;

    const safetyCheckFailure = asset?.SafetyCheckFailure ?? null;

    // ============================================
    // STEP 14: CREDIT SUMMARY
    // ============================================

    const creditSummary = cibilSuccess?.CreditSummaryData || null;

    const oldestCreditAccountPeriod =
      creditSummary?.OldestCreditAccountPeriod || null;

    const inquiries = creditSummary?.Inquires || null;

    const onTimePaymentHistory = creditSummary?.OnTimePaymentHistory || null;

    const creditCardUtilization = creditSummary?.CreditCardUtilization || null;

    const creditMix = creditSummary?.CreditMix || null;

    // ============================================
    // STEP 15: SCORE
    // ============================================

    /*
     * The response you provided does not contain
     * an actual CIBIL score field.
     */

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
    // STEP 16: REPORT URL
    // ============================================

    const reportUrl = apiData?.data?.htmlLink || null;

    // ============================================
    // STEP 17: LOG DATA
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
    // STEP 18: SUCCESS CHECK
    // ============================================

    if (digiStatus !== true || responseStatus !== "Success") {
      return res.status(400).json({
        success: false,

        message: digiMessage || "CIBIL report generation failed",

        error: "CIBIL_REPORT_FAILED",

        statusCode,

        responseStatus,

        responseKey,
      });
    }

    // ============================================
    // STEP 19: SAVE DATABASE
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

    console.log("[DIGI] Credit report saved:", creditReport._id);

    // ============================================
    // STEP 20: SUCCESS RESPONSE
    // ============================================

    return res.status(200).json({
      success: true,

      message: digiMessage || "CIBIL report retrieved successfully from DIGI",

      statusCode,

      responseStatus,

      creditReport: {
        id: creditReport._id,

        name: creditReport.name,

        firstName: creditReport.firstName,

        lastName: creditReport.lastName,

        mobile: creditReport.mobile,

        pan: creditReport.pan,

        gender: creditReport.gender,

        reportType: creditReport.reportType,

        score: creditReport.score,

        bureau: creditReport.bureau,

        reportUrl: creditReport.reportUrl,

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

        localPath: creditReport.localPath || null,

        createdAt: creditReport.createdAt,
      },
    });
  } catch (error) {
    // ============================================
    // STEP 21: UNKNOWN ERROR
    // ============================================

    console.error("[CIBIL] Controller Error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const getCrifReport = async (req, res) => {
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

      // Question / Answer request
      userAns,
      reportId,
      orderId,
    } = req.body;

    // ============================================================
    // STEP 1: DIRECT ENV CONFIG
    // ============================================================

    const baseUrl = process.env.INDICONNECT_BASE_URL;
    const accessKey = process.env.INDICONNECT_ACCESS_KEY;
    const secretKey = process.env.INDICONNECT_SECRET_KEY;
    const serviceKey = process.env.INDICONNECT_SERVICE_KEY;

    const crifEndpoint =
      process.env.INDICONNECT_CRIF_ENDPOINT || "/crifService/crif/score";

    const timeout = 60000;

    // ============================================================
    // STEP 2: CONFIG VALIDATION
    // ============================================================

    if (!baseUrl || !accessKey || !secretKey || !serviceKey) {
      console.error("[CRIF] Missing environment variables");

      return res.status(500).json({
        success: false,
        message: "CRIF API credentials are not configured",
      });
    }

    // ============================================================
    // STEP 3: HEADERS
    // ============================================================

    const headers = {
      Authorization: `x-api-access ${secretKey}:${accessKey}`,
      "service-key": serviceKey,
      "Content-Type": "application/json",
    };

    // ============================================================
    // STEP 4: API URL
    // ============================================================

    const apiUrl =
      `${baseUrl.replace(/\/$/, "")}/` + `${crifEndpoint.replace(/^\//, "")}`;

    console.log("[CRIF] API URL:", apiUrl);

    // Safe logging - NEVER print actual keys
    console.log("[CRIF] ENV CHECK:", {
      baseUrl,
      crifEndpoint,
      accessKeyPresent: !!accessKey,
      secretKeyPresent: !!secretKey,
      serviceKeyPresent: !!serviceKey,
    });

    // ============================================================
    // STEP 5: QUESTION / ANSWER FLOW
    // ============================================================

    const isQuestionRequest =
      userAns !== undefined || reportId !== undefined || orderId !== undefined;

    if (isQuestionRequest) {
      if (!userAns || !reportId || !orderId) {
        return res.status(400).json({
          success: false,
          message:
            "userAns, reportId and orderId are required for CRIF question answer",
        });
      }

      const payload = {
        userAns: String(userAns).trim(),
        reportId: String(reportId).trim(),
        orderId: String(orderId).trim(),
      };

      console.log("[CRIF] Q&A Request:", {
        reportId: payload.reportId,
        orderId: payload.orderId,
        userAns: "***",
      });

      const response = await axios.post(apiUrl, payload, {
        headers,
        timeout,
      });

      const apiData = response.data;

      console.log("[CRIF] Q&A Response:", JSON.stringify(apiData, null, 2));

      return handleCrifResponse(res, apiData);
    }

    // ============================================================
    // STEP 6: INITIAL REQUEST VALIDATION
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
    // STEP 7: CONSENT
    // ============================================================

    if (String(customerConsent).toUpperCase() !== "Y") {
      return res.status(400).json({
        success: false,
        message: "Customer consent must be Y",
      });
    }

    // ============================================================
    // STEP 8: DOB VALIDATION
    // ============================================================

    const dobRegex = /^\d{4}-\d{2}-\d{2}$/;

    if (!dobRegex.test(String(dob).trim())) {
      return res.status(400).json({
        success: false,
        message: "DOB must be in YYYY-MM-DD format",
      });
    }

    // ============================================================
    // STEP 9: INITIAL CRIF PAYLOAD
    // ============================================================

    const payload = {
      panNumber: String(panNumber).trim().toUpperCase(),
      fullName: String(fullName).trim(),
      mobileNumber: String(mobileNumber).trim(),
      email: String(email).trim(),
      dob: String(dob).trim(),
      pincode: String(pincode).trim(),
      stateName: String(stateName).trim(),
      cityName: String(cityName).trim(),
      addressLine1: String(addressLine1).trim(),
      addressLine2: String(addressLine2).trim(),
      customerConsent: "Y",
    };

    console.log("[CRIF] Initial Request:", {
      ...payload,
      panNumber: "********",
    });

    // ============================================================
    // STEP 10: CALL CRIF WITHOUT OTP
    // ============================================================

    const response = await axios.post(apiUrl, payload, {
      headers,
      timeout,
    });

    const apiData = response.data;

    console.log("[CRIF] Initial Response:", JSON.stringify(apiData, null, 2));

    // ============================================================
    // STEP 11: HANDLE RESPONSE
    // ============================================================

    return handleCrifResponse(res, apiData);
  } catch (error) {
    console.error("[CRIF] Error:", error.message);

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
      });
    }

    // ============================================================
    // INTERNAL ERROR
    // ============================================================

    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

const getExperianReport = async (req, res) => {
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
    } = req.body;

    // ============================================================
    // 1. VALIDATION
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
    // 2. CONSENT
    // ============================================================

    if (String(customerConsent).trim().toUpperCase() !== "Y") {
      return res.status(400).json({
        success: false,
        message: "Customer consent must be Y",
      });
    }

    // ============================================================
    // 3. DOB VALIDATION
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
    // 4. NAME
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
    // 5. CLEAN DATA
    // ============================================================

    const pan = String(panNumber).trim().toUpperCase();
    const mobile = String(mobileNumber).trim();
    const pin = String(pincode).trim();

    // ============================================================
    // 6. CONSENT TIMESTAMP
    // ============================================================

    const consentTimestamp = Math.floor(Date.now() / 1000);

    // ============================================================
    // 7. GRAPHQL QUERY
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
    // 8. PAYLOAD
    // ============================================================

    const payload = {
      query,
      variables: {},
    };

    // ============================================================
    // 9. DIRECT ENV CONFIG
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
    // 10. ENV VALIDATION
    // ============================================================

    if (!baseUrl || !accessKey || !secretKey || !serviceKey) {
      console.error("[EXPERIAN] Missing environment variables");

      return res.status(500).json({
        success: false,
        message: "Experian API configuration is missing",
      });
    }

    // ============================================================
    // 11. HEADERS

    // ============================================================

    const headers = {
      myAppId,
      "service-key": serviceKey,
      Authorization: `x-api-access ${secretKey}:${accessKey}`,
      providercode: providerCode,
      "Content-Type": "application/json",
    };

    // ============================================================
    // 12. API URL
    // ============================================================

    const apiUrl =
      `${baseUrl.replace(/\/$/, "")}/` + `${endpoint.replace(/^\//, "")}`;

    console.log("[EXPERIAN] API URL:", apiUrl);

    // Safe logging
    console.log("[EXPERIAN] ENV CHECK:", {
      myAppId,
      providerCode,
      baseUrl,
      endpoint,

      accessKeyPresent: !!accessKey,
      accessKeyPrefix: accessKey.substring(0, 8),
      accessKeyLength: accessKey.length,

      secretKeyPresent: !!secretKey,
      secretKeyPrefix: secretKey.substring(0, 8),
      secretKeyLength: secretKey.length,

      serviceKeyPresent: !!serviceKey,
      serviceKeyPrefix: serviceKey.substring(0, 8),
      serviceKeyLength: serviceKey.length,
    });

    // ============================================================
    // 13. CALL INDICONNECT
    // ============================================================

    const response = await axios.post(apiUrl, payload, {
      headers,
      timeout: 60000,
    });

    const apiData = response.data;

    console.log("[EXPERIAN] RESPONSE:", JSON.stringify(apiData, null, 2));

    // ============================================================
    // 14. VERIFY RESPONSE
    // ============================================================

    const verify = apiData?.data?.verify;

    if (!verify) {
      return res.status(502).json({
        success: false,
        message: "Invalid response from Experian API",
        response: apiData,
      });
    }

    // ============================================================
    // 15. API FAILED
    // ============================================================

    if (!verify.ok) {
      return res.status(400).json({
        success: false,
        message: verify.message || "Experian verification failed",

        error: verify.error || null,

        status: verify.status ?? null,

        result: verify.result || null,
      });
    }

    // ============================================================
    // 16. RESULT
    // ============================================================

    const result = verify.result;

    if (!result) {
      return res.status(400).json({
        success: false,
        message: "Experian report result not received",
        error: verify.error || null,
      });
    }

    // ============================================================
    // 17. SCORE
    // ============================================================

    const score = result?.SCORE?.FCIREXScore ?? null;

    const scoreConfidence = result?.SCORE?.FCIREXScoreConfidLevel ?? null;

    // ============================================================
    // 18. MATCH
    // ============================================================

    const exactMatch = result?.Match_result?.Exact_match ?? null;

    // ============================================================
    // 19. REPORT DETAILS
    // ============================================================

    const creditProfile = result?.CreditProfileHeader || {};

    const reportNumber = creditProfile.ReportNumber ?? null;

    const reportDate = creditProfile.ReportDate ?? null;

    const reportTime = creditProfile.ReportTime ?? null;

    const version = creditProfile.Version ?? null;

    // ============================================================
    // 20. RESPONSE TO FRONTEND
    // ============================================================

    return res.status(200).json({
      success: true,

      message: verify.message || "Experian report generated successfully",

      data: {
        score,

        scoreConfidence,

        exactMatch,

        reportNumber,

        reportDate,

        reportTime,

        version,

        header: result?.Header || null,

        userMessage: result?.UserMessage || null,

        totalCAPS: result?.TotalCAPS_Summary || null,

        caisAccount: result?.CAIS_Account || null,

        caps: result?.CAPS || null,

        nonCreditCAPS: result?.NonCreditCAPS || null,

        currentApplication: result?.Current_Application || null,

        excelExperianReport: result?.excelExperianReport || null,
      },
    });
  } catch (error) {
    console.error("[EXPERIAN] ERROR:", error.message);

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
      });
    }

    // ============================================================
    // INTERNAL ERROR
    // ============================================================

    return res.status(500).json({
      success: false,

      message: "Internal server error",

      error: error.message,
    });
  }
};
const getEquifaxReport = async (req, res) => {
  try {
    const { name, panNumber, mobile, gender, consent } = req.body;

    // ==========================================
    // 1. CONFIG VALIDATION
    // ==========================================

    if (!SUREPASS_CONFIG.baseUrl || !SUREPASS_CONFIG.apiToken) {
      console.error("[EQUIFAX] Surepass configuration missing");

      return res.status(500).json({
        success: false,
        message: "Surepass configuration is missing",
      });
    }

    // ==========================================
    // 2. VALIDATION
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
    // 3. CONSENT VALIDATION
    // ==========================================

    if (String(consent).toUpperCase() !== "Y") {
      return res.status(400).json({
        success: false,
        message: "Customer consent must be Y",
      });
    }

    // ==========================================
    // 4. PAYLOAD
    // ==========================================

    const payload = {
      name: String(name).trim(),

      id_number: String(panNumber).trim().toUpperCase(),

      id_type: "pan",

      mobile: String(mobile).trim(),

      consent: "Y",

      gender: String(gender).trim().toLowerCase(),
    };

    console.log("[EQUIFAX] Request:", {
      ...payload,
      id_number: "********",
    });

    // ==========================================
    // 5. API URL
    // ==========================================

    const apiUrl = `${SUREPASS_CONFIG.baseUrl}${SUREPASS_CONFIG.equifaxEndpoint}`;

    console.log("[EQUIFAX] API URL:", apiUrl);

    // ==========================================
    // 6. HEADERS
    // ==========================================

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUREPASS_CONFIG.apiToken}`,
    };

    // ==========================================
    // 7. CALL SUREPASS
    // ==========================================

    const response = await axios.post(apiUrl, payload, {
      headers,
      timeout: SUREPASS_CONFIG.timeout,
    });

    const apiData = response.data;

    console.log("[EQUIFAX] Response:", JSON.stringify(apiData, null, 2));

    // ==========================================
    // 8. SUCCESS RESPONSE
    // ==========================================

    return res.status(200).json({
      success: true,
      message: "Equifax credit report fetched successfully",
      data: apiData,
    });
  } catch (error) {
    console.error("[EQUIFAX] Error:", error.message);

    // ==========================================
    // API RESPONSE ERROR
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
        error: error.response.data,
      });
    }

    // ==========================================
    // NO RESPONSE
    // ==========================================

    if (error.request) {
      return res.status(504).json({
        success: false,
        message: "Equifax API did not respond",
        errorCode: error.code,
        errorMessage: error.message,
      });
    }

    // ==========================================
    // OTHER ERROR
    // ==========================================

    return res.status(500).json({
      success: false,
      message: "Internal server error",
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

module.exports = {
  getCibilReportFromDigi,
  getCrifReport,
  getExperianReport,
  getEquifaxReport,
};
