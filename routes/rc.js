const express = require("express");
const router = express.Router();
const rcController = require("../controllers/rcController");
const auth = require("../middleware/auth");

router.post("/verify-rc", auth, rcController.verifyRc);
router.get("/my-verifications", auth, rcController.getMyVerifications);

module.exports = router;
