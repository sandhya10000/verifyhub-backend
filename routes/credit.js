const express = require("express");
const router = express.Router();

const {
  getCibilReport,
  fetchCibilReport,

  getCrifReport,
  getEquifaxReport,
  getExperianReport,
} = require("../controllers/creditController");

// CIBIL  POST /api/credit/generate-cibil-report
router.post("/generate-cibil-report", getCibilReport);
router.get("/get-cibil-rpt/:id", fetchCibilReport);

// CRIF POST /api/credit/generate-crif-report
router.post("/generate-crif-report", getCrifReport);

// EQUIFAX POST /api/credit/generate-equifax-report
router.post("/generate-equifax-report", getEquifaxReport);

// EXPERIAN POST /api/credit/generate-experian-report
router.post("/generate-experian-report", getExperianReport);

module.exports = router;
