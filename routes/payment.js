const express = require("express");

const router = express.Router();

const {
  createWalletRechargeOrder,
  verifyPayment,
} = require("../controllers/paymentController");

//API route for wallet recharge
//
// @route   POST /api/wallet-recharge/payment
// @desc    post wallet payment
// @access  Private/User
router.post("/wallet-recharge/payment", createWalletRechargeOrder);

//API route for payment verify
// @route   POST /api/verify/payment
// @desc    post verify payment
// @access  Private/User
router.post("/verify/payment", verifyPayment);
module.exports = router;
