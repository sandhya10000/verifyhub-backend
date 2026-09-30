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

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inr(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "₹0";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(num);
}

function istDate(d) {
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true,
    }).format(new Date(d || Date.now()));
  } catch {
    return new Date(d || Date.now()).toLocaleString();
  }
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

// Generic sender — never throws for missing config in non-production;
// callers needing fire-and-forget should still wrap in try/catch.
async function sendMail({ to, subject, html, text }) {
  if (!to) {
    console.warn("[mail] skipped — no recipient for:", subject);
    return { skipped: true, reason: "no-recipient" };
  }
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("[mail] SMTP not configured –", subject, "for", to);
    return { mocked: true };
  }
  await getTransporter().sendMail({
    from: process.env.SMTP_FROM || `"VerifyHub" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    text: text || undefined,
  });
  return { mocked: false };
}

async function sendOtpMail(to, otp, purpose = "signup") {
  const subject = purpose === "reset" ? "VerifyHub password reset OTP" : "VerifyHub email verification OTP";
  return sendMail({
    to,
    subject,
    html: otpHtml(otp, purpose),
    text: `Your VerifyHub OTP is ${otp}. It expires in ${process.env.OTP_EXPIRY_MIN || 10} minutes.`,
  }).then((r) => {
    if (r.mocked && process.env.NODE_ENV === "production" && process.env.SMTP_USER) throw new Error("Email service not configured");
    // Preserve old contract: throw in production when SMTP missing
    if (r.mocked && process.env.NODE_ENV === "production" && !process.env.SMTP_USER) throw new Error("Email service not configured");
    return r;
  });
}

function receiptShell({ title, preheader, name, introHtml, invoiceRowsHtml, totalsHtml, metaRowsHtml, ctaUrl, ctaLabel }) {
  const dashboardUrl = ctaUrl || process.env.FRONTEND_URL || "https://verifyhub.in";
  return `
<div style="font-family:Arial,Helvetica,sans-serif;background:#f1f4f9;margin:0;padding:24px 12px">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader || title)}</div>
  <div style="max-width:600px;margin:auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e9f2">
    <div style="background:#0f1e3d;padding:22px 28px;color:#ffffff">
      <div style="font-size:20px;font-weight:800;letter-spacing:0.5px">VerifyHub</div>
      <div style="font-size:13px;color:#b9c4dd;margin-top:4px">${esc(title)}</div>
    </div>
    <div style="padding:26px 28px;color:#1e2a44">
      <p style="margin:0 0 6px;font-size:15px">Hi ${esc(name || "Partner")},</p>
      <div style="font-size:14px;color:#42506b;line-height:1.6">${introHtml}</div>

      <div style="margin:20px 0 6px;font-size:13px;font-weight:700;color:#0f1e3d;letter-spacing:0.4px">INVOICE</div>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px">
        <thead>
          <tr>
            <th align="left" style="background:#f4f6fb;padding:10px 12px;color:#5b6a88;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;border:1px solid #e5e9f2">Description</th>
            <th align="right" style="background:#f4f6fb;padding:10px 12px;color:#5b6a88;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;border:1px solid #e5e9f2">Amount</th>
          </tr>
        </thead>
        <tbody>${invoiceRowsHtml}</tbody>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin-top:10px;font-size:14px">
        <tbody>${totalsHtml}</tbody>
      </table>

      <div style="margin:18px 0 6px;font-size:13px;font-weight:700;color:#0f1e3d;letter-spacing:0.4px">PAYMENT DETAILS</div>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:13px;color:#42506b">
        <tbody>${metaRowsHtml}</tbody>
      </table>

      <div style="text-align:center;margin:24px 0 6px">
        <a href="${esc(dashboardUrl)}" style="display:inline-block;background:#1a56db;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 28px;border-radius:8px">${esc(ctaLabel || "Open Dashboard")}</a>
      </div>
      <p style="font-size:12px;color:#8a94ad;line-height:1.6;margin:14px 0 0">This is a system-generated receipt. If you did not make this transaction, please contact support immediately.</p>
    </div>
    <div style="background:#f7f9fc;padding:14px 28px;font-size:12px;color:#8a94ad;border-top:1px solid #e5e9f2">
      VerifyHub · no-reply@verifyhub.in · Need help? Reply to this email.
    </div>
  </div>
</div>`;
}

function row(label, amount) {
  return `<tr><td style="padding:10px 12px;border:1px solid #e5e9f2;color:#2b3854">${esc(label)}</td><td align="right" style="padding:10px 12px;border:1px solid #e5e9f2;color:#2b3854;white-space:nowrap">${esc(amount)}</td></tr>`;
}

function totalRow(label, amount, bold) {
  return `<tr><td align="right" style="padding:${bold ? "10px" : "5px"} 12px 5px 12px;color:${bold ? "#0f1e3d" : "#42506b"};font-weight:${bold ? "800" : "400"};font-size:${bold ? "15px" : "14px"}">${esc(label)}</td><td align="right" style="padding:${bold ? "10px" : "5px"} 0 5px 12px;color:${bold ? "#0f1e3d" : "#42506b"};font-weight:${bold ? "800" : "400"};font-size:${bold ? "15px" : "14px"};white-space:nowrap">${esc(amount)}</td></tr>`;
}

function metaRow(label, value) {
  return `<tr><td style="padding:6px 0;color:#8a94ad;width:42%">${esc(label)}</td><td style="padding:6px 0;color:#1e2a44;font-weight:600;word-break:break-all">${esc(value)}</td></tr>`;
}

// --- Recharge / plan receipts ---

function rechargeInvoiceHtml(d) {
  const invoiceRows = [
    row("Wallet top-up (GST-inclusive)", inr(d.baseAmount)),
    ...(d.plan && Number(d.planFee) > 0 ? [row(`Plan fee — ${String(d.plan).toUpperCase()} (adjusted from top-up)`, `− ${inr(d.planFee)}`)] : []),
    ...(Number(d.gstAmount) > 0 ? [row(`GST @ 18% on top-up`, inr(d.gstAmount))] : []),
  ].join("");
  const totals = [
    totalRow("Paid via Razorpay", inr(d.totalPaid), false),
    totalRow("Wallet credited", inr(d.walletCredit), false),
    totalRow("New wallet balance", inr(d.walletBalance), true),
    ...(d.activePlan ? [totalRow("Active plan", String(d.activePlan).toUpperCase(), false)] : []),
  ].join("");
  const meta = [
    metaRow("Order ID", d.orderId || "—"),
    metaRow("Payment ID", d.paymentId || "—"),
    metaRow("Receipt / Txn ID", d.transactionId || "—"),
    metaRow("Date (IST)", istDate(d.date)),
    ...(d.partnerId ? [metaRow("Partner ID", d.partnerId)] : []),
  ].join("");
  const intro = d.plan
    ? `Thanks for your payment of <b>${esc(inr(d.totalPaid))}</b>. Your <b>${esc(String(d.plan).toUpperCase())}</b> plan is now active and <b>${esc(inr(d.walletCredit))}</b> has been credited to your wallet.`
    : `Thanks for your payment of <b>${esc(inr(d.totalPaid))}</b>. <b>${esc(inr(d.walletCredit))}</b> has been credited to your wallet.`;
  return receiptShell({
    title: d.plan ? "Payment Receipt — Plan + Wallet Top-up" : "Payment Receipt — Wallet Top-up",
    preheader: `Wallet credited ${inr(d.walletCredit)} · Balance ${inr(d.walletBalance)}`,
    name: d.name, introHtml: intro, invoiceRowsHtml: invoiceRows, totalsHtml: totals, metaRowsHtml: meta,
  });
}

async function sendRechargeSuccessMail(to, d) {
  const subject = d.plan
    ? `VerifyHub: ${String(d.plan).toUpperCase()} plan active — ${inr(d.walletCredit)} credited`
    : `VerifyHub: wallet recharged — ${inr(d.walletCredit)} credited`;
  const html = rechargeInvoiceHtml(d);
  const text = [
    `Hi ${d.name || "Partner"},`,
    d.plan ? `Your ${String(d.plan).toUpperCase()} plan is now active (free selection — nothing deducted).` : `Your wallet top-up was successful.`,
    ...(Number(d.gstAmount) > 0 ? [`Base: ${inr(d.baseAmount)} | GST: ${inr(d.gstAmount)} | Paid: ${inr(d.totalPaid)}`] : [`Paid (GST-inclusive): ${inr(d.totalPaid)}`]),
    d.plan && Number(d.planFee) > 0 ? `Plan fee: ${inr(d.planFee)} | ` : "", `Wallet credited: ${inr(d.walletCredit)} | New balance: ${inr(d.walletBalance)}`,
    `Order: ${d.orderId} | Payment: ${d.paymentId} | Date: ${istDate(d.date)}`,
  ].join("\n");
  return sendMail({ to, subject, html, text });
}

function planActivationInvoiceHtml(d) {
  const invoiceRows = [row(`Plan selected — ${String(d.plan).toUpperCase()} (free, no amount deducted)`, inr(0))].join("");
  const totals = [totalRow("Wallet balance (untouched)", inr(d.walletBalance), true), totalRow("Active plan", String(d.plan).toUpperCase(), false)].join("");
  const meta = [
    metaRow("Date (IST)", istDate(d.date)),
    ...(d.partnerId ? [metaRow("Partner ID", d.partnerId)] : []),
  ].join("");
  const intro = `Your <b>${esc(String(d.plan).toUpperCase())}</b> plan is now active. <b>No amount was deducted</b> — your wallet balance stays fully available for report pulls, billed per report at this plan's rates.`;
  return receiptShell({
    title: "Plan Activation Receipt", preheader: `${d.plan} plan active · Balance ${inr(d.walletBalance)}`,
    name: d.name, introHtml: intro, invoiceRowsHtml: invoiceRows, totalsHtml: totals, metaRowsHtml: meta,
  });
}

async function sendPlanActivationMail(to, d) {
  const subject = `VerifyHub: your ${String(d.plan).toUpperCase()} plan is active`;
  return sendMail({
    to, subject, html: planActivationInvoiceHtml(d),
    text: `Hi ${d.name || "Partner"}, your ${String(d.plan).toUpperCase()} plan is active. Nothing was deducted. Balance ${inr(d.walletBalance)}.`,
  });
}

// --- Low-balance alert ---

function lowBalanceHtml({ name, balance, threshold, dashboardUrl }) {
  const url = dashboardUrl || process.env.FRONTEND_URL || "https://verifyhub.in";
  return `
<div style="font-family:Arial,Helvetica,sans-serif;background:#f1f4f9;margin:0;padding:24px 12px">
  <div style="max-width:560px;margin:auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e9f2">
    <div style="background:#b42318;padding:20px 26px;color:#fff">
      <div style="font-size:18px;font-weight:800">VerifyHub — Low wallet balance</div>
      <div style="font-size:13px;color:#ffd9d4;margin-top:4px">Action needed to avoid failed report pulls</div>
    </div>
    <div style="padding:24px 26px;color:#1e2a44">
      <p style="margin:0 0 8px;font-size:15px">Hi ${esc(name || "Partner")},</p>
      <p style="font-size:14px;color:#42506b;line-height:1.6;margin:0 0 14px">Your wallet balance is <b>${esc(inr(balance))}</b>, below the <b>${esc(inr(threshold))}</b> threshold. Please recharge to keep pulling reports without interruption.</p>
      <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:14px 16px;font-size:14px;color:#7c2d12">Current balance: <b>${esc(inr(balance))}</b> &nbsp;·&nbsp; Threshold: <b>${esc(inr(threshold))}</b></div>
      <div style="text-align:center;margin:22px 0 6px">
        <a href="${esc(url)}" style="display:inline-block;background:#1a56db;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 28px;border-radius:8px">Recharge Wallet</a>
      </div>
      <p style="font-size:12px;color:#8a94ad;margin:12px 0 0">You receive this alert at most once every few days while your balance stays low.</p>
    </div>
  </div>
</div>`;
}

async function sendLowBalanceMail(to, { name, balance, threshold }) {
  return sendMail({
    to,
    subject: `VerifyHub: wallet balance low (${inr(balance)}) — please recharge`,
    html: lowBalanceHtml({ name, balance, threshold }),
    text: `Hi ${name || "Partner"}, your VerifyHub wallet balance is ${inr(balance)}, below ${inr(threshold)}. Please recharge to avoid interruptions.`,
  });
}

// --- Admin top-up (no GST: credited amount is final) ---

function adminTopupInvoiceHtml(d) {
  const invoiceRows = [
    row("Admin wallet top-up (no GST)", inr(d.amount)),
    row("Previous balance", inr(d.prevBalance)),
  ].join("");
  const totals = [totalRow("New wallet balance", inr(d.walletBalance), true)].join("");
  const meta = [
    metaRow("Ledger Txn ID", d.transactionId || "—"),
    metaRow("Date (IST)", istDate(d.date)),
    ...(d.note ? [metaRow("Note", d.note)] : []),
    ...(d.partnerId ? [metaRow("Partner ID", d.partnerId)] : []),
  ].join("");
  const intro = `The admin has added <b>${esc(inr(d.amount))}</b> to your wallet. No GST applies — the full amount is credited and ready to use.`;
  return receiptShell({
    title: "Wallet Top-up Receipt", preheader: `${inr(d.amount)} added · Balance ${inr(d.walletBalance)}`,
    name: d.name, introHtml: intro, invoiceRowsHtml: invoiceRows, totalsHtml: totals, metaRowsHtml: meta,
  });
}

async function sendAdminTopupMail(to, d) {
  return sendMail({
    to,
    subject: `VerifyHub: ${inr(d.amount)} added to your wallet`,
    html: adminTopupInvoiceHtml(d),
    text: `Hi ${d.name || "Partner"}, ${inr(d.amount)} was added to your VerifyHub wallet by the admin. Previous balance ${inr(d.prevBalance)}, new balance ${inr(d.walletBalance)}.`,
  });
}

// --- Admin deduct (no GST: debited amount is final) ---

function adminDeductInvoiceHtml(d) {
  const invoiceRows = [
    row("Admin wallet deduction (no GST)", inr(d.amount)),
    row("Previous balance", inr(d.prevBalance)),
  ].join("");
  const totals = [totalRow("New wallet balance", inr(d.walletBalance), true)].join("");
  const meta = [
    metaRow("Ledger Txn ID", d.transactionId || "—"),
    metaRow("Date (IST)", istDate(d.date)),
    ...(d.note ? [metaRow("Note", d.note)] : []),
    ...(d.partnerId ? [metaRow("Partner ID", d.partnerId)] : []),
  ].join("");
  const intro = `The admin has deducted <b>${esc(inr(d.amount))}</b> from your wallet${d.note ? ` (${esc(d.note)})` : ""}. Reply to this email if you believe this is a mistake.`;
  return receiptShell({
    title: "Wallet Deduction Notice", preheader: `${inr(d.amount)} deducted · Balance ${inr(d.walletBalance)}`,
    name: d.name, introHtml: intro, invoiceRowsHtml: invoiceRows, totalsHtml: totals, metaRowsHtml: meta,
  });
}

async function sendAdminDeductMail(to, d) {
  return sendMail({
    to,
    subject: `VerifyHub: ${inr(d.amount)} deducted from your wallet`,
    html: adminDeductInvoiceHtml(d),
    text: `Hi ${d.name || "Partner"}, ${inr(d.amount)} was deducted from your VerifyHub wallet by the admin. Previous balance ${inr(d.prevBalance)}, new balance ${inr(d.walletBalance)}.`,
  });
}

module.exports = {
  sendOtpMail, sendMail, sendRechargeSuccessMail, sendPlanActivationMail, sendLowBalanceMail, sendAdminTopupMail, sendAdminDeductMail,
  getTransporter, resetTransporter, rechargeInvoiceHtml, planActivationInvoiceHtml, lowBalanceHtml, adminTopupInvoiceHtml, adminDeductInvoiceHtml,
};
