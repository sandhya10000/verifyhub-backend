const express = require("express");

const router = express.Router();

const {
  register,
  login,
  forgotPassword,
  requestPasswordReset,
  resetPassword,
  sendSignupOtp,
  verifySignupOtp,
  logout,
} = require("../controllers/authController");
const auth = require("../middleware/auth");

// @route   POST /api/auth/register
// @desc    Register user (requires verified signup OTP)
// @access  Public
router.post("/register", register);

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post("/login", login);

// OTP verification for signup
router.post("/send-signup-otp", sendSignupOtp);
router.post("/verify-signup-otp", verifySignupOtp);

// @route   POST /api/auth/forgot-password
// @desc    Request password reset OTP (legacy alias)
// @access  Public
router.post("/forgot-password", forgotPassword);

// @route   POST /api/auth/request-password-reset
// @desc    Request password reset OTP
// @access  Public
router.post("/request-password-reset", requestPasswordReset);

// @route   POST /api/auth/reset-password
// @desc    Reset password with OTP { email, otp, password }
// @access  Public
router.post("/reset-password", resetPassword);

// @route   POST /api/auth/logout
// @desc    Logout user
// @access  Private
router.post("/logout", auth, logout);

module.exports = router;
