const express = require("express");
const auth = require("../middleware/auth");
const router = express.Router();

const {
  CibilReportFromDigi,
  fetchCibilReport,
  CrifReport,
  EquifaxReport,
  ExperianReport,
  getAllCreditReports,
} = require("../controllers/creditController");

// CIBIL
router.post("/generate-cibil-report", auth, CibilReportFromDigi);

// CRIF
router.post("/generate-crif-report", auth, CrifReport);

// EQUIFAX
router.post("/generate-equifax-report", auth, EquifaxReport);

// EXPERIAN
router.post("/generate-experian-report", auth, ExperianReport);

// GET ALL CREDIT REPORTS
router.get("/get-credit-rpt", auth, getAllCreditReports);

module.exports = router;
