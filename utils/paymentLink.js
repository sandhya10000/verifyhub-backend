const Razorpay = require("razorpay");

// Lazily build a client so the module can be required even when Razorpay
// env vars are absent (local/dev). Returns null in that case.
function razorpayClient() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    return null;
  }
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

function frontendBase() {
  const base =
    process.env.FRONTEND_URL ||
    process.env.PUBLIC_APP_URL ||
    "https://verifyhub.in";
  return String(base).replace(/\/$/, "");
}

// Razorpay expects an E.164 contact. Partner records hold 10-digit numbers.
function toRazorpayContact(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (!d) return undefined;
  if (d.length === 12 && d.startsWith("91")) return `+${d}`;
  if (d.length === 11 && d.startsWith("0")) return `+91${d.slice(1)}`;
  if (d.length === 10) return `+91${d}`;
  return `+${d}`;
}

// Create a hosted Razorpay Payment Link the partner can pay without logging
// in. Returns { id, shortUrl, status } or null when Razorpay is not
// configured / the amount is invalid. Callers treat null as "not sent".
async function createPaymentLink({
  amount,
  name,
  contact,
  email,
  description,
  transactionId,
  orderId,
  purpose,
  callbackPath,
}) {
  const client = razorpayClient();
  if (!client) {
    console.warn("[payment-link] Razorpay not configured — skipping link creation");
    return null;
  }

  const amountPaise = Math.round(Number(amount) * 100);
  if (!Number.isFinite(amountPaise) || amountPaise < 100) {
    console.warn("[payment-link] invalid amount:", amount);
    return null;
  }

  const expirySeconds =
    Number(process.env.PAYMENT_LINK_EXPIRY_SECONDS) || 24 * 60 * 60;
  const expireBy = Math.floor(Date.now() / 1000) + expirySeconds;

  const customer = {
    name: name ? String(name) : undefined,
    contact: toRazorpayContact(contact),
    email: email ? String(email) : undefined,
  };
  Object.keys(customer).forEach((k) => customer[k] === undefined && delete customer[k]);

  const payload = {
    amount: amountPaise,
    currency: "INR",
    accept_partial: false,
    description: description || "VerifyHub payment",
    customer,
    // We deliver the link over WhatsApp ourselves — don't double-send.
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes: {
      transactionId: String(transactionId || ""),
      orderId: String(orderId || ""),
      purpose: String(purpose || ""),
    },
    callback_url: `${frontendBase()}${callbackPath || "/partner/add-funds"}`,
    callback_method: "get",
    expire_by: expireBy,
  };

  const link = await client.paymentLink.create(payload);
  return {
    id: link.id,
    shortUrl: link.short_url,
    status: link.status,
    expiresAt: new Date(expireBy * 1000),
  };
}

module.exports = { createPaymentLink, toRazorpayContact, frontendBase };
