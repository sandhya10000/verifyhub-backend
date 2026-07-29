const express = require("express");

const router = express.Router();

const {
  register,
  login,
  forgotPassword,
  requestPasswordReset,
  resetPassword,
  logout,
} = require("../controllers/authController");
const auth = require("../middleware/auth");

console.log({
  register,
  login,
  forgotPassword,
  requestPasswordReset,
  resetPassword,
  logout,
});
// @route   POST /api/auth/register
// @desc    Register user
// @access  Public
router.post("/register", register);

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post("/login", login);
// @route   POST /api/auth/forgot-password
// @desc    Request password reset (legacy)
// @access  Public
router.post("/forgot-password", forgotPassword);

// @route   POST /api/auth/request-password-reset
// @desc    Request password reset with token
// @access  Public
///router.post("/request-password-reset", requestPasswordReset);

// @route   POST /api/auth/reset-password
// @desc    Reset password with token
// @access  Public
router.post("/reset-password", resetPassword);

// @route   POST /api/auth/logout
// @desc    Logout user
// @access  Private
router.post("/logout", auth, logout);

module.exports = router;
