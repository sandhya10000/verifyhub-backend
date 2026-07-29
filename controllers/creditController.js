const CreditReport = require("../models/creditReport");
const axios = require("axios");

// ======================= RS FINTECH CLIENT =======================
const rsFintechClient = axios.create({
  baseURL: "https://api.rsfintech.in",
  timeout: 60000,
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.RSFINTECH_API_KEY}`,
    "x-api-key": process.env.RSFINTECH_API_KEY,
  },
});

// ======================= COMMON FUNCTION =======================
const fetchCreditReport = async (
  req,
  res,
  endpoint,
  bureau,
  customPayload = null,
) => {
  try {
    let payload;

    if (customPayload) {
      payload = customPayload;
    } else {
      const { name, mobile, pan, consent = "Y" } = req.body;

      if (!name || !mobile || !pan) {
        return res.status(400).json({
          success: false,
          message: "Name, Mobile and PAN are required.",
        });
      }

      payload = {
        name,
        mobile,
        pan,
        consent,
      };
    }

    // Call RS Fintech API
    const response = await rsFintechClient.post(endpoint, payload);

    // Save Report
    const creditReport = await CreditReport.create({
      name: payload.name,
      mobile: payload.mobile,
      pan: payload.pan || payload.id_number,
      bureau: bureau.toLowerCase(),
      reportData: response.data,
      reportUrl:
        response.data?.data?.report_url ||
        response.data?.data?.pdf_url ||
        response.data?.data?.report_link ||
        null,
      score:
        response.data?.data?.score || response.data?.data?.credit_score || null,
    });

    return res.status(200).json({
      success: true,
      bureau,
      message: `${bureau} report fetched successfully.`,
      creditReport,
      data: response.data,
    });
  } catch (error) {
    console.error(
      `${bureau} API Error:`,
      error.response?.data || error.message,
    );

    return res.status(error.response?.status || 500).json({
      success: false,
      bureau,
      message:
        error.response?.data?.message || `Unable to fetch ${bureau} report.`,
      error: error.response?.data || error.message,
    });
  }
};

// ======================= CIBIL =======================
const getCibilReport = async (req, res) => {
  return fetchCreditReport(req, res, "/cibil", "CIBIL");
};

// ======================= CRIF =======================
const getCrifReport = async (req, res) => {
  return fetchCreditReport(req, res, "/crif", "CRIF");
};

// ======================= EXPERIAN =======================
const getExperianReport = async (req, res) => {
  return fetchCreditReport(req, res, "/experian", "EXPERIAN");
};

// ======================= EQUIFAX =======================
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

    if (!name || !id_number || !id_type || !mobile || !gender) {
      return res.status(400).json({
        success: false,
        message: "Name, ID Number, ID Type, Mobile and Gender are required.",
      });
    }

    return fetchCreditReport(req, res, "/equifax", "EQUIFAX", {
      name,
      id_number,
      id_type,
      mobile,
      gender,
      consent,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

module.exports = {
  getCibilReport,
  getCrifReport,
  getExperianReport,
  getEquifaxReport,
};
