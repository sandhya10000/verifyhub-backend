const axios = require("axios");
const RcVerification = require("../models/RcVerification");
const { canAfford, chargeForReport } = require("../utils/wallet");
const { generateRcPdf } = require("../services/rcPdf.service");

const VEHICLE_RE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/;

// Wallet affordability gate — 402 when the partner cannot cover one RC pull.
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

const buildRcQuery = (vehicleNumber, documentType) =>
  `mutation {\n  verify(\n    input: {\n      vehicleNumber: "${vehicleNumber}",\n      documentType: "${documentType}"\n    }\n  ) {\n    ok\n    message\n    result {\n      ... on DTVehicleRcResult {\n          reg_no\n          class\n          chassis\n          engine\n          vehicle_manufacturer_name\n          model\n          vehicle_colour\n          type\n          norms_type\n          body_type\n          owner_count\n          owner_name\n          owner_father_name\n          mobile_number\n          status\n          status_as_on\n          reg_authority\n          reg_date\n          vehicle_manufacturing_month_year\n          rc_expiry_date\n          vehicle_tax_upto\n          vehicle_insurance_company_name\n          vehicle_insurance_upto\n          vehicle_insurance_policy_number\n          rc_financer\n          present_address\n          permanent_address\n          vehicle_cubic_capacity\n          gross_vehicle_weight\n          unladen_weight\n          vehicle_category\n          vehicle_cylinders_no\n          vehicle_seat_capacity\n          wheelbase\n          pucc_number\n          pucc_upto\n          blacklist_status\n          permit_issue_date\n          permit_number\n          permit_type\n          permit_valid_from\n          permit_valid_upto\n          national_permit_upto\n          is_commercial\n          financed\n          rto_code\n      }\n    }\n    error {\n      status\n      message\n      decryptedError\n    }\n  }\n}`;

// POST /api/rc/verify-rc { vehicleNumber, consent }
// Failures are recorded with a reason but NEVER charged (fail-fee deferred).
const verifyRc = async (req, res) => {
  let verification = null;
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "User authentication required" });
    }

    const vehicleNumber = String(req.body?.vehicleNumber || "")
      .toUpperCase()
      .replace(/[\s-]/g, "");
    const consent = req.body?.consent;

    const missingFields = [];
    if (!vehicleNumber) missingFields.push("vehicleNumber");
    if (!consent) missingFields.push("consent");
    if (missingFields.length > 0) {
      return res.status(400).json({ success: false, message: "Missing required fields", missingFields });
    }
    if (consent !== "Y") {
      return res.status(400).json({ success: false, message: "Customer consent (Y) is required" });
    }
    if (!VEHICLE_RE.test(vehicleNumber)) {
      return res.status(400).json({ success: false, message: "Invalid vehicle number format (e.g. MH12AB1234)" });
    }

    const baseUrl = process.env.INDICONNECT_BASE_URL?.trim();
    const accessKey = process.env.INDICONNECT_ACCESS_KEY?.trim();
    const secretKey = process.env.INDICONNECT_SECRET_KEY?.trim();
    const serviceKey = process.env.INDICONNECT_SERVICE_KEY?.trim();
    const providerCode = process.env.INDICONNECT_RC_PROVIDER_CODE?.trim();
    const endpoint = process.env.INDICONNECT_RC_ENDPOINT?.trim() || "/idverifygr/verification";
    const documentType = process.env.INDICONNECT_RC_DOCUMENT_TYPE?.trim() || "vehicle-rc-verification-dt";


    if (!baseUrl || !accessKey || !secretKey || !serviceKey || !providerCode) {
      console.error("[RC] Missing environment variables",baseUrl,accessKey,secretKey,serviceKey,providerCode);
      return res.status(500).json({ success: false, message: "RC API configuration is missing" });
    }

    if (!(await affordOr402(req, res, "rc"))) return;

    const orderId = `rc_${String(userId)}_${Date.now()}`;
    verification = await RcVerification.create({
      userId,
      orderId,
      vehicleNumber,
      consent: "Y",
      documentType,
      status: "Pending",
      reportUrl: null,
      localPath: null,
      rcData: null,
      isPublic: false,
    });

    const headers = {
      "service-key": serviceKey,
      Authorization: `x-api-access ${secretKey}:${accessKey}`,
      providercode: providerCode,
      "Content-Type": "application/json",
    };
    const apiUrl = `${baseUrl.replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`;
    const payload = { query: buildRcQuery(vehicleNumber, documentType), variables: {} };

    const response = await axios.post(apiUrl, payload, { headers, timeout: 60000 });
    const apiData = response.data;
    const verify = apiData?.data?.verify;

    if (!verify || verify.ok !== true || !verify.result) {
      verification.status = "Failed";
      verification.rcData = { error: verify?.error || apiData || "Empty RC response" };
      await verification.save(); // pre-save fills failureReason
      return res.status(400).json({
        success: false,
        status: "failed",
        verificationId: verification._id,
        failureCharge: 0,
        message: verify?.error?.message || verify?.message || "RC verification failed",
        error: verify?.error || null,
      });
    }

    const result = verify.result;
    const pdf = await generateRcPdf(result, verification._id);

    verification.ownerName = result.owner_name || null;
    verification.reportUrl = pdf.success ? pdf.relativePath : null;
    verification.localPath = pdf.success ? pdf.filePath : null;
    verification.rcData = result;
    verification.status = "Success";
    await verification.save();

    // Post-success debit — guarded, idempotent, never throws.
    let charge = { ok: false };
    try {
      charge = await chargeForReport(userId, verification._id, "rc", "RC");
    } catch (err) {
      console.error(`[wallet] charge error for RC verification ${verification._id}:`, err.message);
    }

    return res.status(200).json({
      success: true,
      status: "success",
      message: verify.message || "RC verification completed successfully",
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
        verification.rcData = { error: err.response?.data || err.message };
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
        message: "RC API did not respond",
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

// GET /api/rc/my-verifications?page&limit&search — own RC history, newest first.
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
        { vehicleNumber: { $regex: search, $options: "i" } },
        { ownerName: { $regex: search, $options: "i" } },
      ];
    }

    const [total, rows] = await Promise.all([
      RcVerification.countDocuments(query),
      RcVerification.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select(
          "vehicleNumber ownerName status reportUrl localPath failureReason createdAt " +
          "rcData.reg_date rcData.status rcData.model rcData.vehicle_manufacturer_name " +
          "rcData.vehicle_insurance_upto rcData.vehicle_tax_upto rcData.permit_valid_upto " +
          "rcData.rc_expiry_date rcData.rc_financer rcData.blacklist_status",
        )
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
    console.error("[RC] my-verifications error:", err);
    res.status(500).json({ success: false, message: "Could not fetch verifications" });
  }
};

module.exports = { verifyRc, getMyVerifications };
