const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const User = require("../models/User");
const Otp = require("../models/Otp");
const generateToken = require("../utils/generateToken");
const { sendOtpMail } = require("../utils/sendMail");
const { validateEmailFormat, hasMx, isMailboxNotFoundError } = require("../utils/emailValidation");

const OTP_EXPIRY_MIN = Number(process.env.OTP_EXPIRY_MIN || 10);
const OTP_RESEND_SECONDS = 60;
const MAX_ATTEMPTS = 5;

const normEmail = (e) => String(e || "").trim().toLowerCase();
const normPhone = (p) => String(p || "").replace(/\D/g, "").slice(-10);

function makeOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

async function issueOtp(email, purpose) {
  const otp = makeOtp();
  const otpHash = await bcrypt.hash(otp, 10);
  // Send FIRST – only persist OTP doc on success so failures leave
  // no orphan doc and no false resend-cooldown.
  await sendOtpMail(email, otp, purpose);
  await Otp.deleteMany({ email, purpose });
  await Otp.create({
    email,
    otpHash,
    purpose,
    expiresAt: new Date(Date.now() + OTP_EXPIRY_MIN * 60 * 1000),
  });
  return otp;
}

// Shared pre-send guards: format/blocklist → dupes handled by caller → cooldown → MX
async function preSendChecks(email) {
  const fmt = validateEmailFormat(email);
  if (!fmt.ok) return { error: { status: 400, field: "email", message: fmt.message } };
  const mx = await hasMx(fmt.domain);
  if (!mx.ok) {
    return { error: { status: 400, field: "email", message: "This email domain doesn't accept mail. Please use a real address." } };
  }
  return { email: fmt.email };
}

function mapSendError(e) {
  if (isMailboxNotFoundError(e)) {
    return { status: 400, field: "email", message: "This email address doesn't exist or couldn't receive mail." };
  }
  return { status: 500, message: "Failed to send OTP. Please try again." };
}

async function checkCooldown(email, purpose) {
  const last = await Otp.findOne({ email, purpose }).sort({ updatedAt: -1 });
  if (!last) return 0;
  const elapsed = (Date.now() - new Date(last.updatedAt).getTime()) / 1000;
  const wait = OTP_RESEND_SECONDS - elapsed;
  return wait > 0 ? Math.ceil(wait) : 0;
}

const register = async (req, res) => {
  try {
    const { name, email, phone, password, otp } = req.body;
    const em = normEmail(email);
    const ph = normPhone(phone);
    if (!em || !password) return res.status(400).json({ success: false, message: "Email and password required" });

    const emailTaken = await User.findOne({ email: em });
    if (emailTaken) return res.status(400).json({ success: false, field: "email", message: "Email already registered. Please log in." });
    if (ph) {
      const phoneTaken = await User.findOne({ phone: ph });
      if (phoneTaken) return res.status(400).json({ success: false, field: "phone", message: "Phone number already registered. Please log in." });
    }

    // Require verified signup OTP
    const record = await Otp.findOne({ email: em, purpose: "signup" });
    if (!record || !record.verified) {
      return res.status(400).json({ success: false, message: "Please verify your email OTP first" });
    }
    if (otp && !(await record.compare(String(otp)))) {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email: em, phone: ph || phone, password: hashedPassword });
    await Otp.deleteMany({ email: em, purpose: "signup" });

    res.status(201).json({
      success: true,
      message: "Registration Successful",
      token: generateToken(user._id),
      user: { id: user._id, name: user.name, email: user.email, phone: user.phone, partner_id: user.partner_id },
    });
  } catch (error) {
    // Race-condition safety: unique index violation on email/phone
    if (error && error.code === 11000) {
      const field = error.keyPattern?.phone ? "phone" : error.keyPattern?.email ? "email" : undefined;
      const message = field === "phone"
        ? "Phone number already registered. Please log in."
        : "Email already registered. Please log in.";
      return res.status(400).json({ success: false, field, message });
    }
    res.status(500).json({ success: false, message: error.message });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: normEmail(email) });
    if (!user) return res.status(500).json({ success: false, message: "Invalid Email or Password" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ success: false, message: "Invalid Email or Password" });
    res.json({
      success: true,
      token: generateToken(user._id),
      user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role, partner_id: user.partner_id },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const logout = async (req, res) => {
  res.cookie("token", "none", { expires: new Date(Date.now() + 10 * 1000), httpOnly: true })
    .json({ message: "User logged out successfully" });
};

// POST /auth/send-signup-otp { email, phone }
const sendSignupOtp = async (req, res) => {
  try {
    const pre = await preSendChecks(req.body.email);
    if (pre.error) return res.status(pre.error.status).json({ field: pre.error.field, message: pre.error.message });
    const em = pre.email;
    const ph = normPhone(req.body.phone);
    if (await User.findOne({ email: em })) return res.status(400).json({ field: "email", message: "Email already registered. Please log in." });
    // Fail fast on duplicate phone so we don't waste an OTP email
    if (ph && (await User.findOne({ phone: ph }))) {
      return res.status(400).json({ field: "phone", message: "Phone number already registered. Please log in." });
    }
    const wait = await checkCooldown(em, "signup");
    if (wait > 0) return res.status(429).json({ message: `Please wait ${wait}s before resending`, retryAfter: wait });
    try {
      await issueOtp(em, "signup");
    } catch (sendErr) {
      console.error("sendSignupOtp send:", sendErr);
      const mapped = mapSendError(sendErr);
      return res.status(mapped.status).json({ field: mapped.field, message: mapped.message, error: sendErr.message });
    }
    res.json({ success: true, message: "OTP sent to email", expiresInMin: OTP_EXPIRY_MIN });
  } catch (e) {
    console.error("sendSignupOtp:", e);
    res.status(500).json({ message: "Failed to send OTP", error: e.message });
  }
};

// POST /auth/verify-signup-otp { email, otp }
const verifySignupOtp = async (req, res) => {
  try {
    const em = normEmail(req.body.email);
    const { otp } = req.body;
    const record = await Otp.findOne({ email: em, purpose: "signup" });
    if (!record) return res.status(400).json({ message: "No OTP found. Request a new one." });
    if (record.expiresAt < new Date()) return res.status(400).json({ message: "OTP expired. Request a new one." });
    if (record.attempts >= MAX_ATTEMPTS) return res.status(429).json({ message: "Too many attempts. Request a new OTP." });
    const ok = await record.compare(String(otp || ""));
    if (!ok) {
      record.attempts += 1;
      await record.save();
      return res.status(400).json({ message: "Invalid OTP" });
    }
    record.verified = true;
    record.attempts = 0;
    await record.save();
    res.json({ success: true, message: "Email verified" });
  } catch (e) {
    res.status(500).json({ message: "Server error", error: e.message });
  }
};

// Legacy: keep route working – generate temp password is removed, use OTP reset instead
const forgotPassword = async (req, res) => {
  return requestPasswordReset(req, res);
};

// POST /auth/request-password-reset { email }
const requestPasswordReset = async (req, res) => {
  try {
    const pre = await preSendChecks(req.body.email);
    if (pre.error) return res.status(pre.error.status).json({ field: pre.error.field, message: pre.error.message });
    const em = pre.email;
    const user = await User.findOne({ email: em });
    if (!user) return res.status(404).json({ message: "User not found" });
    const wait = await checkCooldown(em, "reset");
    if (wait > 0) return res.status(429).json({ message: `Please wait ${wait}s before resending`, retryAfter: wait });
    try {
      await issueOtp(em, "reset");
    } catch (sendErr) {
      console.error("requestPasswordReset send:", sendErr);
      const mapped = mapSendError(sendErr);
      return res.status(mapped.status).json({ field: mapped.field, message: mapped.message, error: sendErr.message });
    }
    res.json({ success: true, message: "Password reset OTP sent to email", expiresInMin: OTP_EXPIRY_MIN });
  } catch (e) {
    console.error("requestPasswordReset:", e);
    res.status(500).json({ message: "Server error", error: e.message });
  }
};

// POST /auth/reset-password { email, otp, password }
const resetPassword = async (req, res) => {
  try {
    const em = normEmail(req.body.email);
    const { otp, password, token } = req.body;
    // Back-compat: old token-based flow if token matches a stored reset token
    if (token && !otp) {
      const user = await User.findOne({ resetPasswordToken: token, resetPasswordExpires: { $gt: Date.now() } });
      if (!user) return res.status(400).json({ message: "Password reset token is invalid or has expired" });
      user.password = password;
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;
      await user.save();
      return res.json({ message: "Password has been reset successfully" });
    }
    if (!password || String(password).length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });
    const record = await Otp.findOne({ email: em, purpose: "reset" });
    if (!record) return res.status(400).json({ message: "No OTP found. Request a new one." });
    if (record.expiresAt < new Date()) return res.status(400).json({ message: "OTP expired. Request a new one." });
    if (record.attempts >= MAX_ATTEMPTS) return res.status(429).json({ message: "Too many attempts. Request a new OTP." });
    const ok = await record.compare(String(otp || ""));
    if (!ok) {
      record.attempts += 1;
      await record.save();
      return res.status(400).json({ message: "Invalid OTP" });
    }
    const user = await User.findOne({ email: em });
    if (!user) return res.status(404).json({ message: "User not found" });
    user.password = await bcrypt.hash(password, 10);
    await user.save();
    await Otp.deleteMany({ email: em, purpose: "reset" });
    res.json({ success: true, message: "Password has been reset successfully" });
  } catch (e) {
    console.error("resetPassword:", e);
    res.status(500).json({ message: "Server error", error: e.message });
  }
};

module.exports = { register, login, forgotPassword, requestPasswordReset, resetPassword, sendSignupOtp, verifySignupOtp, logout };
