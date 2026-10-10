const express = require("express");

const router = express.Router();

const auth = require("../middleware/auth");

const {
  createWalletRechargeOrder,
  cancelWalletRechargeOrder,
  verifyPayment,
  activatePlan,
} = require("../controllers/paymentController");

//API route for wallet recharge
//
// @route   POST /api/wallet-recharge/payment
// @desc    post wallet payment
// @access  Private/User
router.post("/wallet-recharge/payment", auth, createWalletRechargeOrder);

//API route for payment verify
// @route   POST /api/verify/payment
// @desc    post verify payment
// @access  Private/User
router.post("/verify/payment", auth, verifyPayment);

//API route for cancelling a pending recharge (modal dismissed / payment failed)
// @route   POST /api/wallet-recharge/cancel
// @desc    mark own PENDING recharge FAILED (SUCCESS rows untouched)
// @access  Private/User
router.post("/wallet-recharge/cancel", auth, cancelWalletRechargeOrder);

// Free plan selection gated by wallet balance (no Razorpay, no debit).
// @route   POST /api/plan/activate
// @desc    set activePlan when balance covers the tier slab (upgrades + downgrades)
// @access  Private/User
router.post("/plan/activate", auth, activatePlan);
module.exports = router;
