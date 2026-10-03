const express = require("express");
const auth = require("../middleware/auth");
// TODO(multi-plan-restore): re-add requirePlanChosen to report routes below.
// const requirePlanChosen = require("../middleware/requirePlanChosen");
const router = express.Router();

const {
  CibilReportFromDigi,
  fetchCibilReport,
  CrifReport,
  EquifaxReport,
  ExperianReport,
  getAllCreditReports,
  getCreditBureauDetails,
} = require("../controllers/creditController");

// CIBIL
//  /api/credit/generate-cibil-report
// Single-plan mode: no plan gate — auth only (single plan auto-applies via wallet tier fallback).
// TODO(multi-plan-restore): re-add requirePlanChosen after auth on all four routes.
router.post("/generate-cibil-report", auth, CibilReportFromDigi);

// CRIF
router.post("/generate-crif-report", auth, CrifReport);

// EQUIFAX
router.post("/generate-equifax-report", auth, EquifaxReport);

// EXPERIAN
router.post("/generate-experian-report", auth, ExperianReport);

//get user detail from credti and user
//api/credit/user/details
router.get("/user/details", auth, getCreditBureauDetails);
// GET ALL CREDIT REPORTS
router.get("/get-credit-rpt", auth, getAllCreditReports);

module.exports = router;
