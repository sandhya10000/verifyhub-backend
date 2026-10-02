const axios = require("axios");

// Wasimple WhatsApp sender — mirrors utils/sendMail.js conventions:
// lazy config, never throws for missing config/recipient (except OTP in
// production), phone log masking, [whatsapp] log prefix.
//
// Required env (fill from app.wasimple.in → Integrations → ApiDocumentation):
//   WASIMPLE_SEND_URL  — full POST URL of the sendMessages endpoint
//                        (e.g. https://<host>/api/<version>/sendMessages)
//   WASIMPLE_API_KEY   — API key for the Authorization header
// Optional env:
//   WASIMPLE_AUTH_HEADER — auth header name (default "Authorization")
//   WASIMPLE_AUTH_SCHEME — scheme prefix, e.g. "Bearer" (default "Bearer");
//                        set to empty string to send the raw key.
//   WASIMPLE_PHONE_ID  — value for the x-phone-id header (WABA tenant);
//                        omit when the account has a single phone number.

function maskPhone(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.length <= 4) return "***";
  return `${d.slice(0, 2)}***${d.slice(-2)}`;
}

// Partner records keep 10-digit numbers — normalize to E.164 (91…).
function normalizePhone(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) return d;
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) return `91${d}`;
  return d; // send as-is; provider validates
}

function inr(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "₹0";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(num);
}

// Generic sender — mirrors sendMail(): {skipped} for no recipient,
// {mocked} when unconfigured, throws only via the OTP wrapper below.
async function sendWhatsApp({ to, text }) {
  const phone = normalizePhone(to);
  if (!phone) {
    console.warn("[whatsapp] skipped — no recipient");
    return { skipped: true, reason: "no-recipient" };
  }
  if (!process.env.WASIMPLE_SEND_URL || !process.env.WASIMPLE_API_KEY) {
    console.warn("[whatsapp] Wasimple not configured – message for", maskPhone(phone), ":", String(text).slice(0, 80));
    return { mocked: true };
  }
  const res = await axios.post(
    `${process.env.WASIMPLE_SEND_URL}?apiKey=${process.env.WASIMPLE_API_KEY}`,
    { to: phone, text },
    // { headers: authHeaders(), timeout: 15000 },
  );
  const messageId =
    res.data?.messageId || res.data?.data?.messageId || res.data?.id || null;
  console.log(`[whatsapp] sent to ${maskPhone(phone)} id=${messageId || "n/a"}`);
  return { mocked: false, messageId, data: res.data };
}

async function sendWhatsAppOtp(phone, otp, purpose = "signup") {
  const what = purpose === "reset" ? "password reset" : "account verification";
  return sendWhatsApp({
    to: phone,
    text:
      `Hello from VerifyHub \u{1F44B}\n` +
      `Your one-time password for ${what} is: *${otp}*\n` +
      `It expires in ${process.env.OTP_EXPIRY_MIN || 10} minutes.\n\n` +
      `If you did not request this, please ignore this message. Never share your OTP with anyone — VerifyHub will never ask for it.`,
  }).then((r) => {
    // Preserve the mail contract: OTP must actually go out in production.
    if (r.mocked && process.env.NODE_ENV === "production") throw new Error("WhatsApp service not configured");
    return r;
  });
}

async function sendRechargeSuccessWhatsApp(phone, d) {
  return sendWhatsApp({
    to: phone,
    text:
      `Payment Successful \u2705\n` +
      `Dear Partner, ${inr(d.credited)} has been credited to your VerifyHub wallet.\n` +
      `New wallet balance: *${inr(d.walletBalance)}*` +
      `${d.activePlan ? `\nActive plan: *${String(d.activePlan).toUpperCase()}*` : ""}\n\n` +
      `Thank you for choosing VerifyHub.`,
  });
}

async function sendPlanActivationWhatsApp(phone, d) {
  return sendWhatsApp({
    to: phone,
    text:
      `Plan Activated \u{1F389}\n` +
      `Dear Partner, your *${String(d.plan).toUpperCase()}* plan is now active.\n` +
      `Wallet balance: *${inr(d.walletBalance)}* (unchanged — plan selection is free).\n\n` +
      `All new report pulls will be billed at ${String(d.plan).toUpperCase()} rates.`,
  });
}

async function sendLowBalanceWhatsApp(phone, { balance, threshold }) {
  const url = process.env.FRONTEND_URL || "https://verifyhub.in";
  return sendWhatsApp({
    to: phone,
    text:
      `\u26A0\uFE0F Low Wallet Balance\n` +
      `Dear Partner, your VerifyHub wallet balance is *${inr(balance)}*, below the recommended minimum of ${inr(threshold)}.\n` +
      `Please recharge soon to avoid interruptions to your report pulls:\n${url}`,
  });
}

async function sendAdminTopupWhatsApp(phone, d) {
  return sendWhatsApp({
    to: phone,
    text:
      `Wallet Credited \u{1F4B0}\n` +
      `Dear Partner, our admin team has added *${inr(d.amount)}* to your VerifyHub wallet.\n` +
      `Previous balance: ${inr(d.prevBalance)}\nNew balance: *${inr(d.walletBalance)}*` +
      `${d.note ? `\nNote: ${d.note}` : ""}`,
  });
}

async function sendAdminDeductWhatsApp(phone, d) {
  return sendWhatsApp({
    to: phone,
    text:
      `Wallet Deduction Notice\n` +
      `Dear Partner, *${inr(d.amount)}* has been deducted from your VerifyHub wallet by our admin team.\n` +
      `New balance: *${inr(d.walletBalance)}*` +
      `${d.note ? `\nReason: ${d.note}` : ""}\n\n` +
      `If you believe this is an error, please reply to our email or contact support.`,
  });
}

async function sendAccountStatusWhatsApp(phone, { name, active }) {
  const greeting = `Dear ${name || "Partner"}`;
  return sendWhatsApp({
    to: phone,
    text: active
      ? `${greeting},\n\nGood news \u{1F389} — your VerifyHub account has been *reactivated*. You can log in and continue pulling reports right away.`
      : `${greeting},\n\nThis is to inform you that your VerifyHub account has been *suspended* by our admin team. You will not be able to log in or pull reports until it is restored.\n\nIf you believe this is a mistake, please contact our support team.`,
  });
}

module.exports = {
  sendWhatsApp,
  sendWhatsAppOtp,
  sendRechargeSuccessWhatsApp,
  sendPlanActivationWhatsApp,
  sendLowBalanceWhatsApp,
  sendAdminTopupWhatsApp,
  sendAdminDeductWhatsApp,
  sendAccountStatusWhatsApp,
  normalizePhone,
};
