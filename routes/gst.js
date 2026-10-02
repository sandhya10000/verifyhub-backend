const express = require("express");
const router = express.Router();
const gstController = require("../controllers/gstController");
const auth = require("../middleware/auth");

router.post("/verify-gst", auth, gstController.verifyGst);
router.get("/my-verifications", auth, gstController.getMyVerifications);

module.exports = router;
