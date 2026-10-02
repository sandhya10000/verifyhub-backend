const express = require("express");
const auth = require("../middleware/auth");
const requirePlanChosen = require("../middleware/requirePlanChosen");
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
router.post("/generate-cibil-report", auth, requirePlanChosen, CibilReportFromDigi);

// CRIF
router.post("/generate-crif-report", auth, requirePlanChosen, CrifReport);

// EQUIFAX
router.post("/generate-equifax-report", auth, requirePlanChosen, EquifaxReport);

// EXPERIAN
router.post("/generate-experian-report", auth, requirePlanChosen, ExperianReport);

//get user detail from credti and user
//api/credit/user/details
router.get("/user/details", auth, getCreditBureauDetails);
// GET ALL CREDIT REPORTS
router.get("/get-credit-rpt", auth, getAllCreditReports);

module.exports = router;
