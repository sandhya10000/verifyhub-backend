const axios = require("axios");
const GstVerification = require("../models/GstVerification");
const User = require("../models/User");
const { canAfford, chargeForReport } = require("../utils/wallet");
const { generateGstPdf } = require("../services/gstPdf.service");

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

const GST_DETAIL_PROJECTION =
  "gstin legalName status reportUrl localPath failureReason failureCategory createdAt " +
  "gstData.taxpayerDetails.lgnm gstData.taxpayerDetails.gstin gstData.taxpayerDetails.sts " +
  "gstData.taxpayerDetails.ctb gstData.taxpayerDetails.dty";

// Wallet affordability gate — 402 when the partner cannot cover one GST pull.
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
    console.error(`[wallet] affordability check failed (${productKey}):`, err.message);
    return true; // fail-open: never block delivery on a pricing hiccup
  }
};

const buildGstQuery = (gstin, documentType) =>
  `mutation {\n  verify(\n    input: {\n      gstin: "${gstin}",\n      documentType: "${documentType}"\n    }\n  ) {\n    ok\n    message\n    status\n    result {\n      ... on DTGSTINAdvancedResult {\n          taxpayerDetails\n          taxpayerReturnDetails\n          goods_service\n          business_places\n      }\n    }\n    error {\n      status\n      message\n      decryptedError\n    }\n  }\n}`;

// POST /api/gst/verify-gst { gstin, consent }
// Failures are recorded with a reason but NEVER charged (fail-fee deferred).
const verifyGst = async (req, res) => {
  let verification = null;
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "User authentication required" });
    }

    const gstin = String(req.body?.gstin || "")
      .toUpperCase()
      .replace(/[\s-]/g, "");
    const consent = req.body?.consent;

    const missingFields = [];
    if (!gstin) missingFields.push("gstin");
    if (!consent) missingFields.push("consent");
    if (missingFields.length > 0) {
      return res.status(400).json({ success: false, message: "Missing required fields", missingFields });
    }
    if (consent !== "Y") {
      return res.status(400).json({ success: false, message: "Customer consent (Y) is required" });
    }
    if (!GSTIN_RE.test(gstin)) {
      return res.status(400).json({ success: false, message: "Invalid GSTIN format (e.g. 27AAXCA1628A1ZR)" });
    }

    const baseUrl = process.env.INDICONNECT_BASE_URL?.trim();
    const accessKey = process.env.INDICONNECT_ACCESS_KEY?.trim();
    const secretKey = process.env.INDICONNECT_SECRET_KEY?.trim();
    const serviceKey = process.env.INDICONNECT_SERVICE_KEY?.trim();
    const providerCode = process.env.INDICONNECT_GST_PROVIDER_CODE?.trim();
    const endpoint = process.env.INDICONNECT_GST_ENDPOINT?.trim() || "/idverifygr/verification";
    const documentType = process.env.INDICONNECT_GST_DOCUMENT_TYPE?.trim() || "gstin-authentication-advanced-dt";

    if (!baseUrl || !accessKey || !secretKey || !serviceKey || !providerCode) {
      console.error("[GST] Missing environment variables");
      return res.status(500).json({ success: false, message: "GST API configuration is missing" });
    }

    if (!(await affordOr402(req, res, "gst"))) return;

    const orderId = `gst_${String(userId)}_${Date.now()}`;
    verification = await GstVerification.create({
      userId,
      orderId,
      gstin,
      consent: "Y",
      documentType,
      status: "Pending",
      reportUrl: null,
      localPath: null,
      gstData: null,
      isPublic: false,
    });

    const headers = {
      "service-key": serviceKey,
      Authorization: `x-api-access ${secretKey}:${accessKey}`,
      providercode: providerCode,
      "Content-Type": "application/json",
    };
    const apiUrl = `${baseUrl.replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`;
    const payload = { query: buildGstQuery(gstin, documentType), variables: {} };

    const response = await axios.post(apiUrl, payload, { headers, timeout: 60000 });
    const apiData = response.data;
    const verify = apiData?.data?.verify;

    if (!verify || verify.ok !== true || !verify.result) {
      verification.status = "Failed";
      verification.gstData = { error: verify?.error || apiData || "Empty GST response" };
      await verification.save(); // pre-save fills failureReason
      return res.status(400).json({
        success: false,
        status: "failed",
        verificationId: verification._id,
        failureCharge: 0,
        message: verify?.error?.message || verify?.message || "GST verification failed",
        error: verify?.error || null,
      });
    }

    const result = verify.result;
    const pdf = await generateGstPdf(result, verification._id);

    verification.legalName = result.taxpayerDetails?.lgnm || null;
    verification.reportUrl = pdf.success ? pdf.relativePath : null;
    verification.localPath = pdf.success ? pdf.filePath : null;
    verification.gstData = result;
    verification.status = "Success";
    await verification.save();

    // Post-success debit — guarded, idempotent, never throws.
    let charge = { ok: false };
    try {
      charge = await chargeForReport(userId, verification._id, "gst", "GST");
    } catch (err) {
      console.error(`[wallet] charge error for GST verification ${verification._id}:`, err.message);
    }

    return res.status(200).json({
      success: true,
      status: "success",
      message: verify.message || "GST verification completed successfully",
      verificationId: verification._id,
      orderId: verification.orderId,
      reportUrl: verification.reportUrl,
      localPath: verification.localPath,
      pdfGenerated: pdf.success,
      charge: charge.ok ? charge.total : 0,
      data: result,
    });
  } catch (err) {
    if (verification) {
      try {
        verification.status = "Failed";
        verification.gstData = { error: err.response?.data || err.message };
        await verification.save();
      } catch { /* ignore */ }
    }
    if (err.response) {
      return res.status(err.response.status || 500).json({
        success: false,
        status: "failed",
        verificationId: verification?._id || null,
        failureCharge: 0,
        error: err.response.data,
      });
    }
    if (err.request) {
      return res.status(504).json({
        success: false,
        status: "failed",
        message: "GST API did not respond",
        verificationId: verification?._id || null,
        failureCharge: 0,
      });
    }
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      verificationId: verification?._id || null,
    });
  }
};

// GET /api/gst/my-verifications?page&limit&search — own GST history, newest first.
const getMyVerifications = async (req, res) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "User authentication required" });
    }
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const search = String(req.query.search || "").trim();

    const query = { userId };
    if (search) {
      query.$or = [
        { gstin: { $regex: search, $options: "i" } },
        { legalName: { $regex: search, $options: "i" } },
      ];
    }

    const [total, rows] = await Promise.all([
      GstVerification.countDocuments(query),
      GstVerification.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select(GST_DETAIL_PROJECTION)
        .lean(),
    ]);
    res.json({
      success: true,
      data: rows,
      total,
      page,
      pages: Math.max(Math.ceil(total / limit), 1),
    });
  } catch (err) {
    console.error("[GST] my-verifications error:", err);
    res.status(500).json({ success: false, message: "Could not fetch verifications" });
  }
};

// GET /api/admin/gst-reports?page&limit&search&partnerSearch&status&startDate&endDate
// All partners' GST verifications, newest first. Admin only.
const getAllGstVerifications = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const search = String(req.query.search || "").trim();
    const partnerSearch = String(req.query.partnerSearch || "").trim();
    const status = String(req.query.status || "All");
    const { startDate, endDate } = req.query;

    const query = {};
    if (search) {
      query.$or = [
        { gstin: { $regex: search, $options: "i" } },
        { legalName: { $regex: search, $options: "i" } },
      ];
    }
    if (partnerSearch) {
      const users = await User.find({
        $or: [
          { name: { $regex: partnerSearch, $options: "i" } },
          { email: { $regex: partnerSearch, $options: "i" } },
          { partner_id: { $regex: partnerSearch, $options: "i" } },
          { phone: { $regex: partnerSearch, $options: "i" } },
        ],
      }).select("_id");
      query.userId = { $in: users.map((u) => u._id) };
    }
    if (status && status !== "All") {
      query.status = status;
    }
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const [total, rows] = await Promise.all([
      GstVerification.countDocuments(query),
      GstVerification.find(query)
        .populate("userId", "name email partner_id phone")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select(GST_DETAIL_PROJECTION)
        .lean(),
    ]);
    res.json({
      success: true,
      data: rows,
      total,
      page,
      pages: Math.max(Math.ceil(total / limit), 1),
    });
  } catch (err) {
    console.error("[GST] admin gst-reports error:", err);
    res.status(500).json({ success: false, message: "Could not fetch GST reports" });
  }
};

module.exports = { verifyGst, getMyVerifications, getAllGstVerifications };
