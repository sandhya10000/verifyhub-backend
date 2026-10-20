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
  return { sent: true, mocked: false, messageId, data: res.data };
}

// Template sender — POST /api/v1/whatsapp/sendMessage with a template body.
// Business-initiated messages to new contacts (like OTPs) MUST use an
// approved template; free-form text is rejected by Meta outside the 24h window.
// Returns {sent} on accept, {mocked} when unconfigured, {skipped} for no
// recipient — never throws (callers decide how to treat failures).
async function sendTemplateMessage({ to, templateName, language, variables }) {
  const phone = normalizePhone(to);
  if (!phone) {
    console.warn("[whatsapp] template skipped — no recipient");
    return { skipped: true, reason: "no-recipient" };
  }
  if (!process.env.WASIMPLE_API_KEY) {
    console.warn(
      "[whatsapp] Wasimple not configured – template",
      templateName,
      "for",
      maskPhone(phone),
    );
    return { mocked: true };
  }
  const base = (process.env.WASIMPLE_BASE_URL || "https://app.wasimple.in").replace(/\/$/, "");
  const url = `${base}/api/v1/whatsapp/sendMessage?apiKey=${process.env.WASIMPLE_API_KEY}`;
  const headers = {};
  if (process.env.WASIMPLE_PHONE_ID) headers["x-phone-id"] = process.env.WASIMPLE_PHONE_ID;
  try {
    const res = await axios.post(
      url,
      {
        templateName,
        language: language || "en",
        to: phone,
        templateVariables: variables || [],
      },
      { headers, timeout: 15000 },
    );
    const messageId =
      res.data?.messageId || res.data?.data?.messageId || res.data?.id || null;
    console.log(`[whatsapp] template ${templateName} sent to ${maskPhone(phone)} id=${messageId || "n/a"}`);
    return { sent: true, mocked: false, messageId, data: res.data };
  } catch (err) {
    const data = err.response?.data;
    const detail =
      (typeof data?.message === "string" && data.message) ||
      (typeof data?.error === "string" && data.error) ||
      (data?.error ? JSON.stringify(data.error) : "") ||
      (data ? JSON.stringify(data).slice(0, 300) : "") ||
      err.message;
    console.error(
      `[whatsapp] template ${templateName} failed for ${maskPhone(phone)} (status ${err.response?.status || "n/a"}):`,
      detail,
    );
    return { sent: false, reason: detail };
  }
}

async function sendWhatsAppOtp(phone, otp, purpose = "signup") {
  // OTPs go via the approved Authentication template (copy-code button) so
  // they reach new contacts outside the 24h window. Free-form text would be
  // rejected by Meta for these cold sends.
  // Best-effort by design: mail remains the delivery gate (see issueOtp),
  // so this never throws — callers map the result via templateStatus().
  return sendTemplateMessage({
    to: phone,
    templateName: process.env.WASIMPLE_OTP_TEMPLATE || "registeration_otp",
    language: process.env.WASIMPLE_OTP_LANG || "en",
    variables: [String(otp)],
  });
}

// Compact delivery status for API responses: "sent" | "failed" | "skipped".
function templateStatus(r) {
  if (!r) return "skipped";
  if (r.sent) return "sent";
  if (r.skipped || r.mocked) return "skipped";
  return "failed";
}

// Single-plan launch: no plan names — one rate card for everyone.
// TODO(multi-plan-restore): revive plan lines below.
async function sendRechargeSuccessWhatsApp(phone, d) {
  const bonus = Math.max(0, Number(d.bonus) || 0);
  const paid = d.paid != null ? inr(d.paid) : null;
  return sendWhatsApp({
    to: phone,
    text:
      `Payment Successful \u2705\n` +
      `Dear Partner, ${inr(d.credited)} has been credited to your VerifyHub wallet.\n` +
      (bonus > 0 ? `Paid: ${paid || inr(Number(d.credited) - bonus)} · Bonus: *${inr(bonus)}*\n` : ``) +
      `New wallet balance: *${inr(d.walletBalance)}*\n` +
      `Reports are billed per pull at standard rates.\n\n` +
      `Thank you for choosing VerifyHub.`,
  });
}

// DEAD in single-plan mode (activatePlan no-op never sends this). Kept for
// multi-plan restore — do not delete.
// TODO(multi-plan-restore): revive plan-activation messages.
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

// Plain, symbol-free amount ("1,000") for templates whose body already prints
// the currency (₹{{2}}). Passing inr() would render "₹₹1,000".
function plainAmount(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "0";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(num);
}

// Payment-failure retry link. Uses the approved utility template configured
// via env (WASIMPLE_PAYMENT_RETRY_TEMPLATE / _LANG). Two payload shapes:
//   - "button" (default): link lives in a URL button, so only 2 body vars
//     [name, amount] are sent.
//   - "body": link is body var {{3}} -> [name, amount, link].
// Templates normally print the currency themselves (e.g. "₹{{2}}"), so the
// amount is sent as a bare number. Set WASIMPLE_PAYMENT_RETRY_CURRENCY_SYMBOL
// only for a template that prints no currency at all.
// Falls back to a free-form message when no template is configured (free-form
// only reaches contacts inside the 24h window).
async function sendPaymentRetryWhatsApp(phone, { name, amount, link, mode }) {
  const linkUrl = String(link || "");
  const templateName = process.env.WASIMPLE_PAYMENT_RETRY_TEMPLATE;
  const language = process.env.WASIMPLE_PAYMENT_RETRY_LANG || "en";
  const templateMode = mode || process.env.WASIMPLE_PAYMENT_RETRY_MODE || "button";

  if (!templateName) {
    return sendWhatsApp({
      to: phone,
      text:
        `Payment not completed\n` +
        `Dear ${name || "Partner"}, your VerifyHub payment of ${inr(amount)} could not be completed.\n` +
        `Please retry securely using this link (valid for 24 hours):\n${linkUrl}`,
    });
  }

  const symbol = process.env.WASIMPLE_PAYMENT_RETRY_CURRENCY_SYMBOL || "";
  const amountText = `${symbol}${plainAmount(amount)}`;
  const variables =
    templateMode === "body"
      ? [String(name || "Partner"), amountText, linkUrl]
      : [String(name || "Partner"), amountText];

  return sendTemplateMessage({
    to: phone,
    templateName,
    language,
    variables,
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
  sendTemplateMessage,
  templateStatus,
  sendWhatsAppOtp,
  sendRechargeSuccessWhatsApp,
  sendPaymentRetryWhatsApp,
  sendPlanActivationWhatsApp,
  sendLowBalanceWhatsApp,
  sendAdminTopupWhatsApp,
  sendAdminDeductWhatsApp,
  sendAccountStatusWhatsApp,
  normalizePhone,
};
