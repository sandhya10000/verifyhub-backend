const express = require("express");
const router = express.Router();

const {
  getCibilReport,
  getCrifReport,
  getEquifaxReport,
  getExperianReport,
} = require("../controllers/creditController");

// CIBIL  POST /api/auth/credit/generate-cibil-report
router.post("/generate-cibil-report", getCibilReport);

// CRIF POST /api/auth/credit/generate-crif-report
router.post("/generate-crif-report", getCrifReport);

// EQUIFAX POST /api/auth/credit/generate-equifax-report
router.post("/generate-equifax-report", getEquifaxReport);

// EXPERIAN POST /api/auth/credit/generate-experian-report
router.post("/generate-experian-report", getExperianReport);

module.exports = router;
