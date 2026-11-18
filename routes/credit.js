const express = require("express");
const auth = require("../middleware/auth");
// TODO(multi-plan-restore): re-add requirePlanChosen to report routes below.
// const requirePlanChosen = require("../middleware/requirePlanChosen");
const router = express.Router();
const { guardProviderBalance } = require("../utils/providerBalanceGuard");

const {
  CibilReportFromDigi,
  CibilReportFromFinpass,
  fetchCibilReport,
  CrifReport,
  EquifaxReport,
  EquifaxReportFromFinpass,
  ExperianReport,
  getAllCreditReports,
  getCreditBureauDetails,
} = require("../controllers/creditController");

// CIBIL
//  /api/credit/generate-cibil-report
// Single-plan mode: no plan gate — auth only (single plan auto-applies via wallet tier fallback).
// TODO(multi-plan-restore): re-add requirePlanChosen after auth on all four routes.
// Provider: Finpass (Digi handler kept above for rollback).
router.post(
  "/generate-cibil-report",
  auth,
  guardProviderBalance("CIBIL", CibilReportFromFinpass),
);

// CRIF
router.post(
  "/generate-crif-report",
  auth,
  guardProviderBalance("CRIF", CrifReport),
);

// EQUIFAX
// Provider: Finpass (legacy Surepass EquifaxReport kept for rollback).
router.post(
  "/generate-equifax-report",
  auth,
  guardProviderBalance("EQUIFAX", EquifaxReportFromFinpass),
);

// EXPERIAN
router.post(
  "/generate-experian-report",
  auth,
  guardProviderBalance("EXPERIAN", ExperianReport),
);

//get user detail from credti and user
//api/credit/user/details
router.get("/user/details", auth, getCreditBureauDetails);
// GET ALL CREDIT REPORTS
router.get("/get-credit-rpt", auth, getAllCreditReports);

module.exports = router;
