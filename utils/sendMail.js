const nodemailer = require("nodemailer");

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const port = Number(process.env.SMTP_PORT || 587);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port,
    secure: port === 465, // SSL on 465 (Hostinger), STARTTLS on 587 (Gmail/Hostinger)
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

// For tests / env switches (e.g. Gmail -> Hostinger) without process restart
function resetTransporter() {
  transporter = null;
}

function otpHtml(otp, purpose) {
  const title = purpose === "reset" ? "Reset your password" : "Verify your email";
  return `
  <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;border:1px solid #eee;border-radius:12px;padding:24px">
    <h2 style="margin:0 0 8px">VerifyHub – ${title}</h2>
    <p style="color:#555">Use this OTP to continue. It expires in ${process.env.OTP_EXPIRY_MIN || 10} minutes.</p>
    <div style="font-size:32px;font-weight:800;letter-spacing:8px;text-align:center;background:#f6f8ff;border-radius:8px;padding:16px;margin:16px 0">${otp}</div>
    <p style="color:#888;font-size:12px">If you did not request this, ignore this email. Do not share this code.</p>
  </div>`;
}

async function sendOtpMail(to, otp, purpose = "signup") {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("[mail] SMTP not configured – OTP for", to, ":", otp);
    if (process.env.NODE_ENV !== "production") return { mocked: true };
    throw new Error("Email service not configured");
  }
  const subject = purpose === "reset" ? "VerifyHub password reset OTP" : "VerifyHub email verification OTP";
  await getTransporter().sendMail({
    from: process.env.SMTP_FROM || `"VerifyHub" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html: otpHtml(otp, purpose),
    text: `Your VerifyHub OTP is ${otp}. It expires in ${process.env.OTP_EXPIRY_MIN || 10} minutes.`,
  });
  return { mocked: false };
}

module.exports = { sendOtpMail, getTransporter, resetTransporter };
