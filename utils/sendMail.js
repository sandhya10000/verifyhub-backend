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
    <h2 style="margin:0 0 8px">Verify Hub – ${title}</h2>
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
    from: process.env.SMTP_FROM || `"Verify Hub" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    text: text || undefined,
  });
  return { mocked: false };
}

async function sendOtpMail(to, otp, purpose = "signup") {
  const subject = purpose === "reset" ? "Verify Hub password reset OTP" : "Verify Hub email verification OTP";
  return sendMail({
    to,
    subject,
    html: otpHtml(otp, purpose),
    text: `Your Verify Hub OTP is ${otp}. It expires in ${process.env.OTP_EXPIRY_MIN || 10} minutes.`,
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
      <div style="font-size:20px;font-weight:800;letter-spacing:0.5px">Verify Hub</div>
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

// Single-plan launch: NO plan names anywhere in live mails — one rate card
// for everyone, so receipts talk wallet + standard rates only.
// TODO(multi-plan-restore): revive plan branches below.
function rechargeInvoiceHtml(d) {
  const invoiceRows = [
    row("Wallet top-up (GST-inclusive)", inr(d.baseAmount)),
    ...(Number(d.gstAmount) > 0 ? [row(`GST @ 18% on top-up`, inr(d.gstAmount))] : []),
  ].join("");
  const totals = [
    totalRow("Paid via Razorpay", inr(d.totalPaid), false),
    totalRow("Wallet credited", inr(d.walletCredit), false),
    totalRow("New wallet balance", inr(d.walletBalance), true),
  ].join("");
  const meta = [
    metaRow("Order ID", d.orderId || "—"),
    metaRow("Payment ID", d.paymentId || "—"),
    metaRow("Receipt / Txn ID", d.transactionId || "—"),
    metaRow("Date (IST)", istDate(d.date)),
    ...(d.partnerId ? [metaRow("Partner ID", d.partnerId)] : []),
  ].join("");
  const intro = `Thanks for your payment of <b>${esc(inr(d.totalPaid))}</b>. <b>${esc(inr(d.walletCredit))}</b> has been credited to your wallet — pull any report, anytime; every report is billed per pull at standard rates.`;
  return receiptShell({
    title: "Payment Receipt — Wallet Top-up",
    preheader: `Wallet credited ${inr(d.walletCredit)} · Balance ${inr(d.walletBalance)}`,
    name: d.name, introHtml: intro, invoiceRowsHtml: invoiceRows, totalsHtml: totals, metaRowsHtml: meta,
  });
}

async function sendRechargeSuccessMail(to, d) {
  const subject = `VerifyHub: wallet recharged — ${inr(d.walletCredit)} credited`;
  const html = rechargeInvoiceHtml(d);
  const text = [
    `Hi ${d.name || "Partner"},`,
    `Your wallet top-up was successful. Pull any report, anytime; every report is billed per pull at standard rates.`,
    ...(Number(d.gstAmount) > 0 ? [`Base: ${inr(d.baseAmount)} | GST: ${inr(d.gstAmount)} | Paid: ${inr(d.totalPaid)}`] : [`Paid (GST-inclusive): ${inr(d.totalPaid)}`]),
    `Wallet credited: ${inr(d.walletCredit)} | New balance: ${inr(d.walletBalance)}`,
    `Order: ${d.orderId} | Payment: ${d.paymentId} | Date: ${istDate(d.date)}`,
  ].join("\n");
  return sendMail({ to, subject, html, text });
}

// DEAD in single-plan mode (activatePlan no-op never sends this). Kept for
// multi-plan restore — do not delete.
// TODO(multi-plan-restore): revive plan-activation mails.
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
  const subject = `Verify Hub: your ${String(d.plan).toUpperCase()} plan is active`;
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
      <div style="font-size:18px;font-weight:800">Verify Hub — Low wallet balance</div>
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
    subject: `Verify Hub: wallet balance low (${inr(balance)}) — please recharge`,
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
    subject: `Verify Hub: ${inr(d.amount)} added to your wallet`,
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
    subject: `Verify Hub: ${inr(d.amount)} deducted from your wallet`,
    html: adminDeductInvoiceHtml(d),
    text: `Hi ${d.name || "Partner"}, ${inr(d.amount)} was deducted from your VerifyHub wallet by the admin. Previous balance ${inr(d.prevBalance)}, new balance ${inr(d.walletBalance)}.`,
  });
}

// --- Partner top-up alert for platform + admins (short, no receipt) ---
// Sent on every successful partner-initiated WALLET_RECHARGE, in addition to
// the partner's own receipt. Never blocks the recharge response (fire-and-forget).

function topupAlertHtml(d) {
  const meta = [
    metaRow("Partner", `${d.name || "—"}${d.partnerId ? ` (${d.partnerId})` : ""}`),
    metaRow("Email", d.email || "—"),
    ...(d.phone ? [metaRow("Phone", d.phone)] : []),
    metaRow("Credited", inr(d.walletCredit)),
    metaRow("New balance", inr(d.walletBalance)),
    metaRow("Order ID", d.orderId || "—"),
    metaRow("Payment ID", d.paymentId || "—"),
    metaRow("Receipt / Txn ID", d.transactionId || "—"),
    metaRow("Date (IST)", istDate(d.date)),
  ].join("");
  return receiptShell({
    title: "Wallet Top-up Alert — Partner Payment Received",
    preheader: `${d.name || "Partner"} credited ${inr(d.walletCredit)} · Balance ${inr(d.walletBalance)}`,
    name: "Admin",
    introHtml: `Partner <b>${esc(d.name || "")}</b> topped up <b>${esc(inr(d.walletCredit))}</b> via Razorpay. New wallet balance is <b>${esc(inr(d.walletBalance))}</b>.`,
    invoiceRowsHtml: row("Wallet credited (partner payment)", inr(d.walletCredit)),
    totalsHtml: totalRow("New wallet balance", inr(d.walletBalance), true),
    metaRowsHtml: meta,
    ctaUrl: process.env.ADMIN_URL || process.env.FRONTEND_URL || "https://verifyhub.in",
    ctaLabel: "Open Admin Panel",
  });
}

async function sendTopupAdminNotifyMail(to, d) {
  const subject = `Top-up alert: ${d.name || "Partner"} credited ${inr(d.walletCredit)} — balance ${inr(d.walletBalance)}`;
  return sendMail({
    to,
    subject,
    html: topupAlertHtml(d),
    text: [
      `Partner ${d.name || ""}${d.partnerId ? ` (${d.partnerId})` : ""} topped up ${inr(d.walletCredit)} via Razorpay.`,
      `New wallet balance: ${inr(d.walletBalance)}.`,
      `Order: ${d.orderId} | Payment: ${d.paymentId} | Date: ${istDate(d.date)}`,
    ].join("\n"),
  });
}

// --- Custom Branded Report subscription mails ---
// Sent on every successful ₹2500 CBR payment (wallet + Razorpay alike).
// Partner gets a receipt; platform + all admins get a short alert.
// Fire-and-forget from the controller — never blocks the payment response.

function cbrReceiptHtml(d) {
  const invoiceRows = [
    row("Custom Branded Report — one-time branding setup fee (GST-inclusive)", inr(d.amount)),
  ].join("");
  const totals = [
    totalRow(`Paid via ${d.method || "—"}`, inr(d.amount), false),
    totalRow("Request ID", d.requestId || "—", true),
  ].join("");
  const meta = [
    metaRow("Request ID", d.requestId || "—"),
    metaRow("Order ID", d.orderId || "—"),
    metaRow("Payment ID", d.paymentId || "—"),
    metaRow("Date (IST)", istDate(d.date)),
    ...(d.partnerId ? [metaRow("Partner ID", d.partnerId)] : []),
  ].join("");
  const intro = `Thanks for subscribing to the <b>AI Custom Branded Report</b> for <b>${esc(inr(d.amount))}</b> (one-time fee). Our team will contact you within <b>1–2 working days</b> to collect your logo, colours and company details. Your approved branding will then apply to all your future reports — note that each AI analysis report is still billed separately per pull at standard rates.`;
  return receiptShell({
    title: "Payment Receipt — Custom Branded Report",
    preheader: `Branded report activated · ${inr(d.amount)} paid · ${d.requestId || ""}`,
    name: d.name, introHtml: intro, invoiceRowsHtml: invoiceRows, totalsHtml: totals, metaRowsHtml: meta,
  });
}

async function sendCbrReceiptMail(to, d) {
  return sendMail({
    to,
    subject: `Verify Hub: Custom Branded Report activated — ${inr(d.amount)} paid (${d.requestId || "receipt"})`,
    html: cbrReceiptHtml(d),
    text: [
      `Hi ${d.name || "Partner"}, your AI Custom Branded Report subscription is active.`,
      `One-time fee paid: ${inr(d.amount)} via ${d.method || "—"}. Request ID: ${d.requestId || "—"}.`,
      `Our team will contact you within 1–2 working days. AI analysis reports are billed separately per pull.`,
    ].join("\n"),
  });
}

function cbrAlertHtml(d) {
  const meta = [
    metaRow("Partner", `${d.name || "—"}${d.partnerId ? ` (${d.partnerId})` : ""}`),
    metaRow("Email", d.email || "—"),
    ...(d.phone ? [metaRow("Phone", d.phone)] : []),
    metaRow("Request ID", d.requestId || "—"),
    metaRow("Amount", `${inr(d.amount)} (${d.method || "—"})`),
    metaRow("Order ID", d.orderId || "—"),
    metaRow("Payment ID", d.paymentId || "—"),
    metaRow("Receipt / Txn ID", d.transactionId || "—"),
    metaRow("Date (IST)", istDate(d.date)),
  ].join("");
  return receiptShell({
    title: "Branded Report Alert — Partner Subscribed (₹2,500)",
    preheader: `${d.name || "Partner"} subscribed to branded reports · ${inr(d.amount)} via ${d.method || "—"}`,
    name: "Admin",
    introHtml: `Partner <b>${esc(d.name || "")}</b> paid the <b>${esc(inr(d.amount))}</b> one-time Custom Branded Report fee via <b>${esc(d.method || "—")}</b>. Please contact them within <b>1–2 working days</b> to collect customisation details.`,
    invoiceRowsHtml: row("Custom Branded Report one-time fee (partner payment)", inr(d.amount)),
    totalsHtml: totalRow("Request ID", d.requestId || "—", true),
    metaRowsHtml: meta,
    ctaUrl: process.env.ADMIN_URL || process.env.FRONTEND_URL || "https://verifyhub.in",
    ctaLabel: "Open Admin Panel",
  });
}

async function sendCbrAdminNotifyMail(to, d) {
  const subject = `Branded report: ${d.name || "Partner"} paid ${inr(d.amount)} (${d.requestId || "new request"})`;
  return sendMail({
    to,
    subject,
    html: cbrAlertHtml(d),
    text: [
      `Partner ${d.name || ""}${d.partnerId ? ` (${d.partnerId})` : ""} paid ${inr(d.amount)} via ${d.method || "—"} for the Custom Branded Report.`,
      `Request: ${d.requestId} | Order: ${d.orderId} | Payment: ${d.paymentId} | Date: ${istDate(d.date)}`,
      `Contact them within 1–2 working days: ${d.email || ""}${d.phone ? ` / ${d.phone}` : ""}.`,
    ].join("\n"),
  });
}

// --- Support ticket resolution mail ---
// Sent to the partner when an admin marks their ticket resolved. Includes the
// ticket number, category (tag), issue description and resolution timestamp.
// Fire-and-forget from the controller — never blocks the status update.

function ticketResolvedHtml(d) {
  const meta = [
    metaRow("Ticket number", d.reference || String(d.ticketId || "—")),
    metaRow("Category", d.category || "—"),
    metaRow("Status", "Resolved"),
    metaRow("Resolved on (IST)", istDate(d.resolvedAt)),
    ...(d.partnerId ? [metaRow("Partner ID", d.partnerId)] : []),
  ].join("");
  return receiptShell({
    title: "Support Ticket Resolved",
    preheader: `Ticket ${d.reference || ""} resolved · ${d.category || ""}`,
    name: d.name,
    introHtml: `Good news — your support ticket has been <b>resolved</b> by our team. Here are the ticket details for your records. If the issue persists, please raise a new ticket from the Support page.`,
    invoiceRowsHtml: row(`Ticket issue: ${d.description || "—"}`, "Resolved"),
    totalsHtml: totalRow("Ticket number", d.reference || "—", true),
    metaRowsHtml: meta,
    ctaUrl: process.env.FRONTEND_URL || "https://verifyhub.in",
    ctaLabel: "Open Support",
  });
}

async function sendTicketResolvedMail(to, d) {
  const subject = `Verify Hub: ticket ${d.reference || ""} resolved — ${d.category || "support"}`;
  return sendMail({
    to,
    subject,
    html: ticketResolvedHtml(d),
    text: [
      `Hi ${d.name || "Partner"}, your support ticket has been resolved.`,
      `Ticket number: ${d.reference || d.ticketId || "—"}`,
      `Category: ${d.category || "—"}`,
      `Issue: ${d.description || "—"}`,
      `Resolved on: ${istDate(d.resolvedAt)}`,
      `If the issue persists, please raise a new ticket from the Support page.`,
    ].join("\n"),
  }).catch((e) => {
    console.error("[mail] ticket resolved mail failed:", e.message);
    return { failed: true };
  });
}

module.exports = {
  sendOtpMail, sendMail, sendRechargeSuccessMail, sendPlanActivationMail, sendLowBalanceMail, sendAdminTopupMail, sendAdminDeductMail, sendTopupAdminNotifyMail,
  sendCbrReceiptMail, sendCbrAdminNotifyMail, sendTicketResolvedMail,
  getTransporter, resetTransporter, rechargeInvoiceHtml, planActivationInvoiceHtml, lowBalanceHtml, adminTopupInvoiceHtml, adminDeductInvoiceHtml,
};
